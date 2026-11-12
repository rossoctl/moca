package vmpool

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// requireKVM skips unless SH_KVM=1, following the repo's SH_LIVE_RELAY / M3_LIVE_SMOKE
// convention so `make test` stays green on a laptop (spec §8). No hypervisor is
// available to this task's own environment, so TestFirecrackerRestoresPausedAndRunsOneCommand
// and TestFirecrackerMountsAtAcquireNotAtRestore below are written against the real
// FirecrackerOptions/VM contract but can only be exercised on a rig with /dev/kvm and a
// built golden snapshot — see the task-15 report.
// A skip here is a HOLE IN THE EVIDENCE, not a pass, and the skip message says so
// because a reader scanning output has nothing else to go on. Which of spec §8's gates
// this affects, and what does run without a rig, is spelled out in
// gates_inventory_test.go — a test that fails if that inventory ever drifts away from
// the code.
func requireKVM(t *testing.T) {
	t.Helper()
	if os.Getenv("SH_KVM") != "1" {
		t.Skip("NOT RUN (no signal, not a pass): needs /dev/kvm and a golden snapshot built by " +
			"deploy/microvm/build-snapshot.sh. Standard GitHub runners have neither, so this gate " +
			"is enforced only on the rig — see gates_inventory_test.go and " +
			".github/workflows/microvm-kvm-gates.yml; set SH_KVM=1 there")
	}
	if _, err := os.Stat("/dev/kvm"); err != nil {
		t.Fatalf("SH_KVM=1 but /dev/kvm is unusable: %v", err)
	}
}

func fcLauncher(t *testing.T) Launcher { return fcLauncherWith(t, nil) }

// fcLauncherWith is fcLauncher with a hook to adjust the options (e.g. set Egress) before the
// launcher is built, so a gate that needs one extra option does not duplicate this body.
func fcLauncherWith(t *testing.T, mod func(*FirecrackerOptions)) Launcher {
	t.Helper()
	snapshotDir := envOr("SH_SNAPSHOT_IMAGE_DIR", "/srv/snapshots/swebench-py311")
	opts := FirecrackerOptions{
		SnapshotDir:         snapshotDir,
		JailerBin:           envOr("SH_JAILER_BIN", "/usr/bin/jailer"),
		FirecrackerBin:      envOr("SH_FIRECRACKER_BIN", "/usr/bin/firecracker"),
		ChrootBase:          sameDeviceSiblingDir(t, snapshotDir),
		UID:                 os.Getuid(),
		GID:                 os.Getgid(),
		WorkspaceImageBytes: 2 << 30,
		VsockPort:           1024,
	}
	if mod != nil {
		mod(&opts)
	}
	lc, err := NewFirecrackerLauncher(opts)
	if err != nil {
		t.Fatalf("NewFirecrackerLauncher: %v", err)
	}
	return lc
}

// sameDeviceSiblingDir returns a fresh directory guaranteed by construction to share a
// device with snapshotDir's parent, for use as a hardlink target next to the golden
// snapshot -- mirroring new_verify_dir() in deploy/microvm/build-snapshot.sh, which
// solves the identical problem for the shell harness's own restore-verification jail
// (see commit 4059338). Both VMM arms hardlink (never copy) snapshot components into a
// per-run directory -- Firecracker's jailer into ChrootBase/<id>/root/, Cloud
// Hypervisor's Restore into RunDir/<id>/ -- deliberately, so N standby VMs sharing one
// golden snapshot don't each duplicate a multi-hundred-MiB memfile. A hardlink across
// devices is EXDEV, unconditionally, so t.TempDir() alone cannot stand in here: it
// honours $TMPDIR, which has no reason to share a device with wherever the snapshot
// lives (on the rig, /tmp is tmpfs and the snapshot is on /srv's ext4).
//
// SH_CHROOT_BASE overrides the parent directory outright, for a rig with an unusual
// layout; absent that, the parent defaults to snapshotDir's own parent directory, which
// must already exist -- this deliberately does not os.MkdirAll it into existence, the
// same way new_verify_dir()'s mktemp -d fails loudly on a missing $(dirname "$OUT")
// rather than silently creating one.
func sameDeviceSiblingDir(t *testing.T, snapshotDir string) string {
	t.Helper()
	parent := envOr("SH_CHROOT_BASE", filepath.Dir(snapshotDir))
	dir, err := os.MkdirTemp(parent, ".gates-hardlink-jail-")
	if err != nil {
		t.Fatalf("same-device sibling dir: MkdirTemp under %s (a sibling of snapshot dir "+
			"%s, so hardlinks into it land on the same device -- see new_verify_dir in "+
			"deploy/microvm/build-snapshot.sh, or set SH_CHROOT_BASE): %v", parent, snapshotDir, err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Logf("cleanup same-device sibling dir %s: %v", dir, err)
		}
	})
	// Review finding (fix round 3): os.MkdirTemp creates dir at mode 0700,
	// root-owned when these gates run as root -- gates_kvm_test.go's poolFor
	// and this file's own fcLauncher require exactly that (see round 1's fix).
	// On the Firecracker arm a 0700 root-owned dir is harmless: jailer's whole
	// process tree runs as root too, so root needs no permission bit to enter
	// anywhere. On the Cloud Hypervisor arm it is NOT harmless: virtiofsd drops
	// privileges to VirtiofsdUID/GID (an unprivileged uid, e.g. 65534 "nobody" —
	// CHVOptions.validate() refuses 0) before it ever touches the workspace
	// directory this function's callers nest beneath dir (chvOpts's RunDir,
	// and every per-run WorkspaceDir under a WorkspaceRoot rooted here), and the
	// kernel checks execute permission on EVERY ancestor between "/" and that
	// workspace, not just the workspace's own (correctly chowned, by
	// chvPrepareOwnership) mode. A 0700 ancestor blocks that unprivileged
	// traversal exactly as effectively as a 0700 leaf would -- this is the bug
	// the coordinator diagnosed on the rig: virtiofsd's own EACCES on this
	// ancestor surfaced as the misleading "does not exist" on the leaf it could
	// never reach.
	//
	// chmod to 0711 -- execute-without-read -- rather than 0755: it lets an
	// unprivileged process traverse THROUGH to a path it already knows the name
	// of, without letting it list what else is in here (the standard "reachable
	// but not listable" posture), so this jail's other per-run contents stay
	// unlistable by anyone but its root owner. Do NOT tighten this back to
	// 0700: root needs no permission bit at all, so every Firecracker gate
	// would keep passing while every Cloud Hypervisor one silently broke again.
	if err := os.Chmod(dir, 0o711); err != nil {
		t.Fatalf("same-device sibling dir: chmod %s to 0711 (needed so an unprivileged "+
			"virtiofsd can traverse into it -- see this function's doc comment): %v", dir, err)
	}
	return dir
}

// deviceOf returns the device number of the filesystem holding path, for asserting two
// directories share a device (the condition a cross-device hardlink needs). Delegates to
// the production deviceNumber (device_unix.go / device_other.go) rather than keeping a
// second, test-only *syscall.Stat_t lookup: this package already has to carry that
// build-tag split for pool.New's own startup check (checkPathsShareDevice), and a
// duplicate here broke `GOOS=windows go vet ./...` -- Stat_t does not exist on that
// platform, and vet, unlike build, compiles _test.go files too. On a platform where
// deviceNumber cannot answer (device_other.go's stub), this skips rather than fails: that
// stub is a documented "unsupported here", not a bug this test should report.
func deviceOf(t *testing.T, path string) uint64 {
	t.Helper()
	dev, err := deviceNumber(path)
	if err != nil {
		t.Skipf("deviceNumber(%s): %v (this platform cannot verify device-sharing; see device_other.go)", path, err)
	}
	return dev
}

// TestSameDeviceSiblingDirSharesDeviceWithTarget is the assertion that would have caught
// fcLauncher's original bug -- ChrootBase: t.TempDir() -- without needing a hypervisor:
// on the rig, /tmp (tmpfs) and /srv (ext4, where the golden snapshot lives) are different
// devices, so the jailer's hardlink of every snapshot component into ChrootBase always
// failed EXDEV. sameDeviceSiblingDir exists specifically so that never happens again;
// this test holds it to that.
//
// It stands in a t.TempDir() for the snapshot directory rather than requiring the real
// one (SH_SNAPSHOT_IMAGE_DIR) to exist, per spec §8: the gates that need no KVM must
// never require rig-only state, and this check is about which *device* a directory
// lands on relative to another, not about the snapshot's contents.
func TestSameDeviceSiblingDirSharesDeviceWithTarget(t *testing.T) {
	snapshotDir := t.TempDir()

	got := sameDeviceSiblingDir(t, snapshotDir)

	wantDev := deviceOf(t, filepath.Dir(snapshotDir))
	gotDev := deviceOf(t, got)
	if gotDev != wantDev {
		t.Fatalf("sameDeviceSiblingDir(%s) = %s, on device %d; want device %d (same as %s) -- "+
			"a hardlink from the snapshot dir into this directory would be cross-device and "+
			"therefore always fail EXDEV", snapshotDir, got, gotDev, wantDev, filepath.Dir(snapshotDir))
	}
}

// TestSameDeviceSiblingDirIsTraversableButNotListable is fix round 3's Item 1
// mutation test: pins the exact mode sameDeviceSiblingDir chmods its directory
// to, and that it is exactly 0711 -- not os.MkdirTemp's own default 0700 (the
// bug the coordinator diagnosed on the rig: a root-owned 0700 ancestor blocks
// an unprivileged virtiofsd's traversal into a correctly-chowned workspace
// beneath it), and not a looser 0755 (the coordinator's explicit "reachable
// but not listable" choice). Reverting the chmod call's argument to 0700, or
// deleting the chmod entirely, makes this fail immediately -- observed locally
// (see this task's report): with the chmod removed, this test fails with
// "mode = 0700, want 0711"; restoring the chmod makes it pass again.
func TestSameDeviceSiblingDirIsTraversableButNotListable(t *testing.T) {
	snapshotDir := t.TempDir()
	dir := sameDeviceSiblingDir(t, snapshotDir)

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat %s: %v", dir, err)
	}
	if got := info.Mode().Perm(); got != 0o711 {
		t.Fatalf("sameDeviceSiblingDir(%s) mode = %04o, want 0711 (execute-without-read: "+
			"traversable by an unprivileged virtiofsd, not listable by it)", dir, got)
	}
}

func TestFirecrackerRestoresPausedAndRunsOneCommand(t *testing.T) {
	requireKVM(t)
	lc := fcLauncher(t)
	dir := t.TempDir()
	vm, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-fc-1", Key: "run-a", WorkspaceDir: dir, GuestRAMBytes: 256 << 20,
	})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	defer func() { _ = vm.Destroy() }()
	// Resume both unpauses the VM AND mounts /workspace (mount-at-acquire, spec
	// §4.3; see launcher.go's VM.Resume doc comment) — unlike the brief's own Step 7
	// draft, which put the mount in Run's wrapCommand. Resume failing here would
	// mean either the unpause or the mount failed; either is a Resume-time error,
	// not something Run needs to detect.
	if err := vm.Resume(context.Background()); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	var out capturingSink
	res, err := vm.Run(context.Background(), Command{Command: "echo hi", TimeoutS: 30, CapBytes: OutputCapBytes}, &out)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode != 0 || out.out() != "hi\n" {
		t.Fatalf("res=%+v stdout=%q", res, out.out())
	}
}

func TestFirecrackerMountsAtAcquireNotAtRestore(t *testing.T) {
	requireKVM(t)
	lc := fcLauncher(t)
	dir := t.TempDir()
	// TWO standbys for one run, both restored before either is resumed. Spec §4.3: two
	// guest kernels mounting one ext4 rw corrupt it, and pre-mounted standbys do exactly
	// that with ZERO concurrent Execs — so this must be safe, which is only true if the
	// mount happens at acquire (i.e. inside Resume, not Restore).
	var vms []VM
	for _, id := range []string{"vm-fc-a", "vm-fc-b"} {
		vm, err := lc.Restore(context.Background(), RestoreRequest{ID: id, Key: "run-a", WorkspaceDir: dir, GuestRAMBytes: 256 << 20})
		if err != nil {
			t.Fatalf("Restore %s: %v", id, err)
		}
		defer func() { _ = vm.Destroy() }()
		vms = append(vms, vm)
	}
	// Serially: the arm cannot hold the rw mount twice, which is why
	// SerializesExecsPerRun() is true for it.
	for i, vm := range vms {
		if err := vm.Resume(context.Background()); err != nil {
			t.Fatalf("Resume %d: %v", i, err)
		}
		var out capturingSink
		cmd := "echo " + string(rune('a'+i)) + " >> log.txt; cat log.txt"
		if _, err := vm.Run(context.Background(), Command{Command: cmd, TimeoutS: 30, CapBytes: OutputCapBytes}, &out); err != nil {
			t.Fatalf("Run %d: %v", i, err)
		}
		if i == 1 && out.out() != "a\nb\n" {
			// The write from the first VM survived the second's fresh mount, which is
			// the durability gate the mandatory `sync` (in Run's wrapCommand) exists
			// for (spec §4.3, §6).
			t.Fatalf("second VM saw %q, want %q", out.out(), "a\nb\n")
		}
		if err := vm.Destroy(); err != nil {
			t.Fatalf("Destroy %d: %v", i, err)
		}
	}
}

func TestFirecrackerSerializesExecsPerRun(t *testing.T) {
	// A pure contract assertion, no KVM needed: the pool reads this to decide whether to
	// hold a per-run Exec mutex, and getting it wrong corrupts an ext4 (spec §4.3). Never
	// calls Restore, so the base is never created; it is short only because construction checks
	// that the API socket path fits sun_path (macOS's t.TempDir() does not).
	lc, err := NewFirecrackerLauncher(FirecrackerOptions{SnapshotDir: t.TempDir(), JailerBin: "/bin/true", FirecrackerBin: "/bin/true", ChrootBase: "/srv/jail"})
	if err != nil {
		t.Fatalf("NewFirecrackerLauncher: %v", err)
	}
	if !lc.SerializesExecsPerRun() {
		t.Fatal("the Firecracker arm MUST serialize Execs per run: only one VM may hold the rw ext4 mount")
	}
	if lc.Kind() != Firecracker {
		t.Fatalf("Kind = %q", lc.Kind())
	}
}

// A command that ends in its own `exit` must not be able to skip the wrapper's sync.
// Every writeFileCommand-based put ends its script with `exit 0`/`exit 1`
// (packages/sandbox-client/src/tools.ts), and any run script may call exit — so this
// is the canonical client write shape, not a corner. The VM is SIGKILLed as soon as
// the command's shell is gone, so a sync the command's exit jumped over takes the
// guest page cache — and with it every write the command made — to the grave (spec
// §8's durability gate; caught live 2026-10-20: puts vanished while plain echo writes
// survived). The command must therefore run in a SUBSHELL, so its exit ends the
// subshell and the sync after it still runs.
//
// No KVM needed: bash's xtrace is the observable. `bash -x` prints every command it
// executes to stderr, so "did execution reach sync" is a substring test on the trace —
// a wrapper whose command can terminate the whole shell shows no sync line at all,
// which is precisely the bug. (The cd to /workspace fails on a test host; that is
// fine — the wrapper has no set -e, and only the trace after it matters.)
func TestWrapCommandSyncSurvivesCommandExit(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skipf("bash not available: %v", err)
	}
	for _, tc := range []struct {
		name string
		cmd  string
		want int
	}{
		{"exit zero", "echo hi; exit 0", 0},
		{"exit nonzero", "echo hi; exit 7", 7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stderr bytes.Buffer
			bash := exec.Command("bash", "-x", "-c", wrapCommand(tc.cmd))
			bash.Stderr = &stderr
			err := bash.Run()
			code := 0
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else if err != nil {
				t.Fatalf("bash: %v", err)
			}
			// The command's own exit code is Run's contract (wrapCommand's own comment:
			// sync must not be able to change what the worker reports) — so the fix must
			// preserve it, not just reach sync.
			if code != tc.want {
				t.Fatalf("wrapper exited %d, want %d (the command's own code)", code, tc.want)
			}
			trace := stderr.String()
			if !strings.Contains(trace, "sync") {
				t.Fatalf("sync never ran — the command's exit terminated the wrapper shell "+
					"before its sync, so the command's writes would die with the VM's page "+
					"cache.\nxtrace:\n%s", trace)
			}
		})
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ParentCgroup empty means jailer's own default placement is used and --parent-cgroup is omitted
// entirely (firecrackerCgroupArgs returns nil), so the launcher builds no pool and a VM carries no
// cgroup of ours. Destroy must not invent one or fail. This is the shape every non-cgroup
// deployment takes, so it is worth its own test rather than being implied by the pooled path.
func TestDestroyToleratesNoPooledCgroup(t *testing.T) {
	jailRoot := filepath.Join(t.TempDir(), "jail", "vm-8", "root")
	if err := os.MkdirAll(jailRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	vm := &firecrackerVM{id: "vm-8", key: "run-1", jailRoot: jailRoot}
	if err := vm.Destroy(); err != nil {
		t.Fatalf("Destroy with no pooled cgroup: %v", err)
	}
	if _, err := os.Stat(jailRoot); !os.IsNotExist(err) {
		t.Fatalf("jailRoot survived Destroy (err=%v)", err)
	}
}

// Destroy is idempotent. Deliberately NOT presented as a test of the cgroup path: the `destroyed`
// early-return sits BEFORE it, so a second call never reaches the release and this could not fail
// for that reason. The pool's own behaviour on a second release, and on a cgroup that has
// vanished, is pinned in cgroup_pool_test.go where it can actually fail.
func TestDestroyIsIdempotent(t *testing.T) {
	jailRoot := filepath.Join(t.TempDir(), "jail", "vm-9", "root")
	if err := os.MkdirAll(jailRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	vm := &firecrackerVM{id: "vm-9", key: "run-1", jailRoot: jailRoot}
	if err := vm.Destroy(); err != nil {
		t.Fatalf("first Destroy: %v", err)
	}
	if err := vm.Destroy(); err != nil {
		t.Fatalf("second Destroy must be a no-op, got: %v", err)
	}
}

// removeCgroupDir's ENOENT tolerance, tested directly rather than through Destroy, since it
// is the property both the startup sweep and the steady-state path rest on.
func TestRemoveCgroupDirToleratesAMissingDirectory(t *testing.T) {
	if err := removeCgroupDir(filepath.Join(t.TempDir(), "never-existed")); err != nil {
		t.Fatalf("removeCgroupDir on a missing path: %v", err)
	}
}

// #258 Task 3.1. Destroy is the largest phase of an Exec and the only one with no internal
// visibility: the re-run measured it at 36.77 ms (c=4), 65.06 ms (c=16) and 164.27 ms (c=64),
// growing 4.5x across the sweep while Resume and Run stayed flat, and `throughput =
// slots / per-Exec total` predicts every point within 3-4% -- so this phase is directly on the
// throughput path. Which of its four steps costs that is currently unknown.
//
// Emitted behind SH_DIAG_PHASES like the restore phases, and parsed by whatever aggregates a
// run, so the field names are asserted here: a silently renamed field reads downstream as a
// missing phase rather than as an error.
func TestDestroyEmitsItsSubPhasesUnderDiagPhases(t *testing.T) {
	var lines []string
	restore := phaseLog
	phaseLog = func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }
	t.Cleanup(func() { phaseLog = restore })

	root := t.TempDir()
	const parent = "microvm.slice/microvm-vms.slice"
	if err := os.MkdirAll(filepath.Join(root, parent), 0o755); err != nil {
		t.Fatal(err)
	}
	pool := newCgroupPool(parent, (256+32)<<20, root)
	rel, err := pool.acquire()
	if err != nil {
		t.Fatal(err)
	}
	jailRoot := filepath.Join(t.TempDir(), "jail", "vm-77", "root")
	if err := os.MkdirAll(jailRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	// cgrouprmdir_us keeps its name but now measures the RELEASE (#258), so the aggregate
	// tooling that parses these lines is unchanged.
	vm := &firecrackerVM{id: "vm-77", key: "run-1", jailRoot: jailRoot, cgroups: pool, cgroupRel: rel}
	if err := vm.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}

	var got string
	for _, l := range lines {
		if strings.Contains(l, "destroy phases") {
			got = l
		}
	}
	if got == "" {
		t.Fatalf("no destroy phase line emitted; lines=%v", lines)
	}
	// Every sub-step of Destroy, plus the id to correlate with the restore line and the total
	// so the parts can be checked against the whole.
	// drain_us splits cmd.Wait at os/exec's own boundary between reaping the VMM and
	// draining the stdout/stderr copy goroutines (#307), so it is named here for the same
	// reason as the rest: the aggregate tooling reads these names, and 89% of Destroy
	// landing in "wait" is the reading this field exists to disambiguate.
	for _, want := range []string{
		"id=vm-77", "kill_us=", "wait_us=", "drain_us=", "removeall_us=", "cgroupwait_us=", "cgrouprmdir_us=", "total_us=",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("destroy phase line missing %q: %s", want, got)
		}
	}
}

// A nil phaseLog IS the SH_DIAG_PHASES-unset state (diag.go sets it once, in init), so this is
// the path every production Exec takes -- and the one that would actually panic: a Destroy that
// formatted its line before checking the gate would nil-deref here. Named for the nil path
// rather than for "emits nothing", because asserting that nothing was emitted needs a different
// mechanism -- see TestDestroyEmitsNothingWithoutDiagPhases below.
func TestDestroyToleratesANilPhaseLog(t *testing.T) {
	restore := phaseLog
	phaseLog = nil
	t.Cleanup(func() { phaseLog = restore })

	jailRoot := filepath.Join(t.TempDir(), "jail", "vm-78", "root")
	if err := os.MkdirAll(jailRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	vm := &firecrackerVM{id: "vm-78", key: "run-1", jailRoot: jailRoot}
	if err := vm.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
}

// A Destroy on the hot path must not format a line nobody reads. A counting phaseLog stub
// cannot check that: a non-nil phaseLog IS diagnostics being ON, so a stub would be counting
// the enabled path and asserting it stays silent. What "off" means is instead asserted against
// the destination -- the standard logger, which is where phaseLog points when SH_DIAG_PHASES=1
// (log.Printf). That also catches the regression the name promises and a stub would miss: a
// later change emitting the line via log.Printf directly, bypassing the gate entirely.
//
// cgroupDir is set so every sub-phase runs, including the branch that would emit.
func TestDestroyEmitsNothingWithoutDiagPhases(t *testing.T) {
	restore := phaseLog
	phaseLog = nil
	t.Cleanup(func() { phaseLog = restore })

	var logged bytes.Buffer
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&logged)
	log.SetFlags(0)
	t.Cleanup(func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) })

	// A real pooled cgroup, so the whole Destroy path runs -- including the release. That makes
	// this assertion cover one more regression than it did before pooling: a release that logged
	// on its happy path would put a line here on every single Exec. The release's leak and
	// vanished-directory branches DO log, deliberately, and neither is taken here.
	root := t.TempDir()
	const parent = "microvm.slice/microvm-vms.slice"
	if err := os.MkdirAll(filepath.Join(root, parent), 0o755); err != nil {
		t.Fatal(err)
	}
	pool := newCgroupPool(parent, (256+32)<<20, root)
	rel, err := pool.acquire()
	if err != nil {
		t.Fatal(err)
	}
	jailRoot := filepath.Join(t.TempDir(), "jail", "vm-79", "root")
	if err := os.MkdirAll(jailRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	vm := &firecrackerVM{id: "vm-79", key: "run-1", jailRoot: jailRoot, cgroups: pool, cgroupRel: rel}
	if err := vm.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}

	if logged.Len() != 0 {
		t.Errorf("Destroy logged %q with SH_DIAG_PHASES unset, want nothing", logged.String())
	}
}

// TestFirecrackerResumePhasesRoundTrip pins the stash/read pair that carries Resume's
// decomposition out of the launcher. Resume itself cannot run without a real Firecracker,
// so the stamps inside it are not covered here — what IS covered is that a stashed value
// comes back, in the right slot, under the mutex, and that a fresh VM reads zero.
//
// The slot ordering matters enough to assert with three DISTINCT values: the three fields
// have the same type, so transposing two of them at either end compiles, and would
// silently relabel 78-81% of the phase as the dial.
func TestFirecrackerResumePhasesRoundTrip(t *testing.T) {
	v := &firecrackerVM{}

	// Zero before any Resume -- this is the value resumePhaser (diag.go) documents as
	// "not decomposed", and the shape a partially-failed Resume reports for the steps it
	// never entered.
	if vm, vd, mo := v.ResumePhases(); vm != 0 || vd != 0 || mo != 0 {
		t.Fatalf("fresh VM: ResumePhases() = (%v, %v, %v), want all zero", vm, vd, mo)
	}

	wantVM, wantDial, wantMount := 300*time.Microsecond, 2*time.Millisecond, 20*time.Millisecond
	v.stashResumePhases(wantVM, wantDial, wantMount)
	gotVM, gotDial, gotMount := v.ResumePhases()
	if gotVM != wantVM || gotDial != wantDial || gotMount != wantMount {
		t.Errorf("ResumePhases() = (%v, %v, %v), want (%v, %v, %v)",
			gotVM, gotDial, gotMount, wantVM, wantDial, wantMount)
	}

	// Last-write-wins, which is what "the LAST Resume's" means in the struct comment: a
	// second attempt on the same VM must not blend with the first.
	v.stashResumePhases(time.Millisecond, 2*time.Millisecond, 3*time.Millisecond)
	if vm, vd, mo := v.ResumePhases(); vm != time.Millisecond || vd != 2*time.Millisecond || mo != 3*time.Millisecond {
		t.Errorf("after restash: ResumePhases() = (%v, %v, %v), want (1ms, 2ms, 3ms)", vm, vd, mo)
	}
}

// TestFirecrackerResumeResetsPhasesOnRefusal pins the one branch of Resume that needs no
// hypervisor: checkNotDestroyed returns before any Firecracker contact.
//
// The stash defer must be registered ABOVE that guard. Below it, this path stashed nothing
// and left the previous values in place -- so resumePhaser's "a failed Resume overwrites
// the previous one's values" had a silent exception, and pool.go, which reads the stash
// unconditionally on the error path, would attribute another attempt's real measurements to
// the refused one. Zeros it has a story for; someone else's numbers it does not.
func TestFirecrackerResumeResetsPhasesOnRefusal(t *testing.T) {
	v := &firecrackerVM{id: "vm-refused"}
	v.stashResumePhases(300*time.Microsecond, 2*time.Millisecond, 20*time.Millisecond)
	v.destroyed = true

	if err := v.Resume(context.Background()); err == nil {
		t.Fatal("Resume on a destroyed VM returned nil, want a used-after-Destroy error")
	}
	if vm, vd, mo := v.ResumePhases(); vm != 0 || vd != 0 || mo != 0 {
		t.Errorf("after a refused Resume: ResumePhases() = (%v, %v, %v), want all zero -- "+
			"the stash defer is below the checkNotDestroyed guard, so the refused attempt "+
			"is reporting the previous attempt's measurements as its own", vm, vd, mo)
	}
}
