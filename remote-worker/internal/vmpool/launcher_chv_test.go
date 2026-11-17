package vmpool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func chvOpts(t *testing.T) CHVOptions {
	t.Helper()
	snapshotDir := envOr("SH_SNAPSHOT_IMAGE_DIR", t.TempDir())
	return CHVOptions{
		SnapshotDir:  snapshotDir,
		CHVBin:       envOr("SH_CHV_BIN", "/usr/bin/cloud-hypervisor"),
		ChRemoteBin:  envOr("SH_CH_REMOTE_BIN", "/usr/bin/ch-remote"),
		VirtiofsdBin: envOr("SH_VIRTIOFSD_BIN", "/usr/libexec/virtiofsd"),
		// RunDir must share a device with snapshotDir: Restore() hardlinks the golden
		// vmstate/memory-ranges files (os.Link) from SnapshotDir into RunDir/<id>/, and a
		// hardlink across devices is EXDEV, unconditionally -- the same failure mode
		// fcLauncher's ChrootBase had (see sameDeviceSiblingDir in
		// launcher_firecracker_test.go, which this reuses). When SH_SNAPSHOT_IMAGE_DIR is
		// unset, snapshotDir is itself a t.TempDir(), so the plain default below already
		// lands beside it on the same device; when it is set to a rig path like
		// /srv/snapshots/..., this is what keeps RunDir off of tmpfs.
		RunDir:       sameDeviceSiblingDir(t, snapshotDir),
		VirtiofsdUID: 65534, // nobody
		VirtiofsdGID: 65534,
		VsockPort:    1024,
	}
}

func TestCloudHypervisorDoesNotSerializeExecsPerRun(t *testing.T) {
	lc, err := NewCloudHypervisorLauncher(chvOpts(t))
	if err != nil {
		t.Fatalf("NewCloudHypervisorLauncher: %v", err)
	}
	if lc.Kind() != CloudHypervisor {
		t.Fatalf("Kind = %q", lc.Kind())
	}
	// Spec §4.3's decisive row: with virtio-fs the host filesystem arbitrates, so D>1
	// standbys and concurrent Execs per run are both fine. This is the whole reason the
	// VMM is a seam rather than a build choice.
	if lc.SerializesExecsPerRun() {
		t.Fatal("the Cloud Hypervisor arm must NOT serialize Execs per run")
	}
}

func TestVirtiofsdIsNeverRunAsRoot(t *testing.T) {
	opts := chvOpts(t)
	opts.VirtiofsdUID, opts.VirtiofsdGID = 0, 0
	// Spec §3.5: with virtio-fs, guest path resolution happens in virtiofsd on the HOST,
	// so it is the confinement boundary for the whole design — a root virtiofsd
	// compromise would be host root and would render the microVM boundary decorative.
	// Refusing at construction is the only place this can be enforced once and for all.
	if _, err := NewCloudHypervisorLauncher(opts); err == nil {
		t.Fatal("NewCloudHypervisorLauncher accepted VirtiofsdUID=0")
	}
}

func TestVirtiofsdArgvCarriesItsSandbox(t *testing.T) {
	// A pure argv assertion: --sandbox=namespace is virtiofsd's own confinement, and
	// spec §6's malicious-symlink row says it must be "configured and verified, never
	// assumed".
	argv := virtiofsdArgv(chvOpts(t), "/run/vfsd-1.sock", "/srv/workspaces/run-a")
	joined := strings.Join(argv, " ")
	for _, want := range []string{"--socket-path=/run/vfsd-1.sock", "--shared-dir=/srv/workspaces/run-a", "--sandbox=namespace", "--cache=never"} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv %q is missing %q", joined, want)
		}
	}
	if strings.Contains(joined, "--sandbox=none") {
		t.Error("--sandbox=none disables the boundary the whole design leans on")
	}
	// Corrections C1: --cache=auto disconnects the virtio-fs session immediately on the
	// installed virtiofsd build; --cache=never is the one that stays up. Guard against a
	// regression back to the brief's original (wrong) default.
	if strings.Contains(joined, "--cache=auto") {
		t.Error("--cache=auto is a known dead end (disconnects immediately) — must not appear in argv")
	}
	// Round 5: the inverse of the guard above — the brief DEMANDED
	// --inode-file-handles=mandatory, and this asserts it is ABSENT. That inversion is
	// deliberate, not a mistake: mandatory file handles require CAP_DAC_READ_SEARCH to
	// open a file handle for the shared directory's root node, which the unprivileged
	// VirtiofsdUID/GID this design requires (enforced by TestVirtiofsdIsNeverRunAsRoot
	// above, per spec §3.5) does not have. Confirmed on real hardware: at uid 65534
	// with --inode-file-handles=mandatory, virtiofsd logs "Failed to open file handle
	// for the root node: Operation not permitted (os error 1)" and exits before its
	// vhost-user socket ever appears; without the flag (or at root, which this design
	// forbids), it starts fine. If a future reader restores this flag "per the
	// brief", they will silently break the CH arm again in exactly this way — this
	// assertion exists so that regression fails loudly in CI instead of quietly on
	// the rig.
	if strings.Contains(joined, "--inode-file-handles=mandatory") {
		t.Error("--inode-file-handles=mandatory requires CAP_DAC_READ_SEARCH, which the unprivileged VirtiofsdUID this design requires (spec §3.5) does not have — confirmed on real hardware (\"Operation not permitted\" opening a file handle for the root node); must not reappear in argv")
	}
}

// TestChvRestoreConfigArgIsPositionalNotAFlag is a pure argv-shape assertion for
// the round-6 fix: ch-remote's restore subcommand takes exactly one required
// POSITIONAL argument (a comma-separated key=value string), not a "--source-url"
// flag. Confirmed against the real ch-remote CLI source
// (cloud-hypervisor/src/bin/ch-remote.rs) and `ch-remote restore --help` on the
// installed v53.0 — see chvRestoreConfigArg's doc comment. This regressed once
// already (exit status 2: "unexpected argument '--source-url' found"); this test
// exists so that regression fails loudly here instead of quietly on the rig.
func TestChvRestoreConfigArgIsPositionalNotAFlag(t *testing.T) {
	arg := chvRestoreConfigArg("/run/vm-a")
	if strings.Contains(arg, "--source-url") {
		t.Errorf("restore_config %q must not contain a --source-url flag — restore_config is a single positional comma-separated key=value string, not a set of flags", arg)
	}
	if !strings.Contains(arg, "source_url=") {
		t.Errorf("restore_config %q is missing source_url=", arg)
	}
	if !strings.Contains(arg, "file:///run/vm-a") {
		t.Errorf("restore_config %q does not carry the run dir as a file:// URL", arg)
	}
	// Standbys are restored PAUSED (spec §3.2: a paused VM costs zero CPU, which is
	// what lets many standbys exist without burning cores on timer ticks). resume
	// must be passed explicitly rather than left to ch-remote's default, so a future
	// upstream default change can't silently turn every restored standby running.
	if !strings.Contains(arg, "resume=false") {
		t.Errorf("restore_config %q must explicitly carry resume=false — standbys are restored paused, and this must not rely on ch-remote's default (spec §3.2)", arg)
	}
	// The whole config must be ONE comma-separated positional string, not multiple
	// space-separated tokens masquerading as one (which would silently turn back into
	// flag-like argv splitting at the exec.Command call site).
	if strings.Contains(arg, " ") {
		t.Errorf("restore_config %q contains a space — must be one comma-separated token, not multiple argv entries", arg)
	}

	// Also assert the actual exec.CommandContext argv this produces, at the call
	// site's own construction shape: "restore" is followed by exactly ONE arg, and
	// that arg is the positional config string above — never split across
	// "--source-url", "<url>" as two separate argv entries the way the pre-round-6
	// code did.
	argv := []string{"--api-socket", "/run/api.sock", "restore", chvRestoreConfigArg("/run/vm-a")}
	for i, a := range argv {
		if a == "restore" {
			if i != len(argv)-2 {
				t.Fatalf("argv %q: \"restore\" must be followed by exactly one argument", argv)
			}
			if strings.HasPrefix(argv[i+1], "--") {
				t.Errorf("argv %q: the argument after \"restore\" must be the positional restore_config string, not a flag", argv)
			}
		}
	}
}

// TestCloudHypervisorParentCgroupRequiresMemoryMax is validate()'s mirror of
// launcher_firecracker.go's identical check: a ParentCgroup with no memory bound
// would leave systemd-run --scope creating a per-VM cgroup with no memory.max at
// all, which is this arm's version of D1's "half-wired state".
func TestCloudHypervisorParentCgroupRequiresMemoryMax(t *testing.T) {
	opts := chvOpts(t)
	opts.ParentCgroup = "/sys/fs/cgroup/microvm-vms.slice"
	opts.CgroupMemoryMaxBytes = 0
	if _, err := NewCloudHypervisorLauncher(opts); err == nil {
		t.Fatal("NewCloudHypervisorLauncher accepted ParentCgroup with CgroupMemoryMaxBytes <= 0")
	}
}

// TestCloudHypervisorSystemdRunScopeAgreesWithPerVMBytes is
// TestFirecrackerJailerCgroupMemoryMaxAgreesWithPerVMBytes's mirror for this arm
// (D1/D3): the -p MemoryMax= value systemd-run --scope is told to set must equal
// vmpool.PerVMBytes(cfg), not a second, independently maintained constant.
func TestCloudHypervisorSystemdRunScopeAgreesWithPerVMBytes(t *testing.T) {
	cfg := Config{
		GuestRAMBytes:   256 << 20,
		VMOverheadBytes: DefaultVMOverheadBytes,
	}
	want := PerVMBytes(cfg)

	opts := chvOpts(t)
	opts.ParentCgroup = "/sys/fs/cgroup/microvm-vms.slice"
	opts.CgroupMemoryMaxBytes = want
	opts.setDefaults()
	if err := opts.validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}

	args := chvSystemdRunScopeArgv(opts, "vm-7")
	joined := strings.Join(args, " ")
	wantFlag := "MemoryMax=" + strconv.FormatInt(want, 10)
	if !strings.Contains(joined, wantFlag) {
		t.Fatalf("systemd-run args %q do not contain %q — the cgroup bound has drifted from PerVMBytes(cfg) = %d", joined, wantFlag, want)
	}
	if !strings.Contains(joined, "--slice=microvm-vms.slice") {
		t.Fatalf("systemd-run args %q do not target the microvm-vms.slice parent (spec §5.3: both arms must agree on the same slice)", joined)
	}
}

// TestChvCgroupSliceNameStripsTheCgroupfsPrefix guards the ParentCgroup ->
// --slice translation: systemd-run --slice wants a bare unit name
// ("microvm-vms.slice"), not the full cgroupfs path
// ("/sys/fs/cgroup/microvm-vms.slice") FirecrackerOptions.ParentCgroup and this
// arm's own ParentCgroup share.
func TestChvCgroupSliceNameStripsTheCgroupfsPrefix(t *testing.T) {
	got := chvCgroupSliceName("/sys/fs/cgroup/microvm-vms.slice")
	if got != "microvm-vms.slice" {
		t.Fatalf("chvCgroupSliceName = %q, want %q", got, "microvm-vms.slice")
	}
}

// TestChvVMMArgvCarriesItsOwnLogFile is fix round 12's (task-16 report) test
// deliverable: the coordinator captured a real hang where cloud-hypervisor's
// and virtiofsd's own words were both alive-but-invisible — virtiofsd's
// because nothing read virtiofsd.log back (already fixed, fix round 1, item
// 2), cloud-hypervisor's because vmmCmd.Stdout/Stderr only ever captured
// whatever process Go's exec.Cmd directly spawned, which — when
// l.opts.ParentCgroup wraps CH in `systemd-run --scope` — is systemd-run
// itself, not cloud-hypervisor (this file's package-level D3 comment). The
// captured console.log proved it: one line, systemd-run's own pre-exec
// "Running scope as unit: ..." announcement, never anything CH itself wrote.
//
// The fix does not depend on guessing how systemd-run --scope treats stdio:
// cloud-hypervisor is told its own --log-file path directly in ITS OWN argv,
// so it opens and writes that file itself regardless of which process was
// directly exec'd or what that process's inherited fds turn out to be. This
// test is a pure assertion on chvVMMArgv, split out of Restore's own
// construction for exactly this purpose (see that function's doc comment) —
// no process is spawned, so it needs neither KVM nor root and runs anywhere.
//
// Two cases, and the wrapped one is the one that matters: --log-file must
// SURVIVE being wrapped behind systemd-run's own prefix, remaining part of
// cloud-hypervisor's own trailing args (after l.opts.CHVBin in the wrapped
// argv) rather than being swallowed by, or confused with, systemd-run's own
// flags — a mutation that dropped it only in the wrapped branch would
// otherwise still pass an unwrapped-only test.
func TestChvVMMArgvCarriesItsOwnLogFile(t *testing.T) {
	const apiSock = "/run/vm-test/api.sock"
	const logPath = "/run/vm-test/cloud-hypervisor.log"

	t.Run("unwrapped (no ParentCgroup)", func(t *testing.T) {
		opts := chvOpts(t)
		opts.setDefaults()
		bin, argv := chvVMMArgv(opts, "", apiSock, logPath)
		if bin != opts.CHVBin {
			t.Fatalf("bin = %q, want opts.CHVBin %q — unwrapped, cloud-hypervisor is exec'd directly", bin, opts.CHVBin)
		}
		joined := strings.Join(argv, " ")
		for _, want := range []string{"--log-file", logPath, "-v", "--api-socket", apiSock} {
			if !strings.Contains(joined, want) {
				t.Errorf("unwrapped argv %q is missing %q", joined, want)
			}
		}
		if strings.Contains(joined, "--scope") {
			t.Errorf("unwrapped argv %q must not contain systemd-run's --scope — ParentCgroup is empty", joined)
		}
	})

	t.Run("wrapped (ParentCgroup set)", func(t *testing.T) {
		opts := chvOpts(t)
		opts.ParentCgroup = "/sys/fs/cgroup/microvm-vms.slice"
		opts.CgroupMemoryMaxBytes = 256 << 20
		opts.setDefaults()
		bin, argv := chvVMMArgv(opts, "vm-test", apiSock, logPath)
		if bin != opts.SystemdRunBin {
			t.Fatalf("bin = %q, want opts.SystemdRunBin %q — wrapped, systemd-run is exec'd directly and CH is its argument", bin, opts.SystemdRunBin)
		}
		joined := strings.Join(argv, " ")
		for _, want := range []string{"--scope", "vm-test", "microvm-vms.slice", opts.CHVBin, "--log-file", logPath, "-v", "--api-socket", apiSock} {
			if !strings.Contains(joined, want) {
				t.Errorf("wrapped argv %q is missing %q", joined, want)
			}
		}

		// The load-bearing assertion: --log-file must appear AFTER opts.CHVBin in the
		// argv, i.e. as one of cloud-hypervisor's OWN trailing args, not spliced into
		// or lost among systemd-run's own prefix flags. Index-based, not
		// strings.Contains, specifically to catch a mutation that moved or dropped it
		// only on this branch.
		chvIdx, logIdx := -1, -1
		for i, a := range argv {
			if a == opts.CHVBin {
				chvIdx = i
			}
			if a == "--log-file" {
				logIdx = i
			}
		}
		if chvIdx == -1 {
			t.Fatalf("wrapped argv %v does not contain opts.CHVBin %q at all", argv, opts.CHVBin)
		}
		if logIdx == -1 {
			t.Fatalf("wrapped argv %v does not contain --log-file at all", argv)
		}
		if logIdx <= chvIdx {
			t.Fatalf("wrapped argv %v: --log-file at index %d must come AFTER opts.CHVBin at index %d — it must be one of cloud-hypervisor's own args, not part of systemd-run's own prefix", argv, logIdx, chvIdx)
		}
		if logIdx+1 >= len(argv) || argv[logIdx+1] != logPath {
			t.Fatalf("wrapped argv %v: --log-file at index %d is not immediately followed by the log path %q", argv, logIdx, logPath)
		}
	})
}

// TestRestorePreparesVirtiofsdOwnership covers fix round 1, item 1: Restore
// must chown both paths virtiofsd needs (the run dir it binds its own socket
// inside, and the workspace it must traverse into and serve) to the uid/gid
// it drops to via SysProcAttr.Credential — otherwise the unprivileged posture
// CHVOptions.VirtiofsdUID/GID's doc comment requires cannot actually start
// (virtiofsd's own bind()/traversal hits EACCES the instant it runs).
//
// This cannot be tested against the real os.Chown without root (a non-root
// test runner has neither CAP_CHOWN nor, generally, ownership of a freshly
// created t.TempDir() under another uid) — stated explicitly, per this
// round's own instruction, rather than adding an assertion that cannot fail.
// What IS tested here, by substituting the indirected chvChown, is that
// Restore's ownership-preparation step calls chown for exactly the run dir
// and the workspace dir, with the configured (non-zero) uid/gid — not uid/gid
// 0, and not skipped.
func TestRestorePreparesVirtiofsdOwnership(t *testing.T) {
	orig := chvChown
	defer func() { chvChown = orig }()

	type call struct {
		path     string
		uid, gid int
	}
	var calls []call
	chvChown = func(path string, uid, gid int) error {
		calls = append(calls, call{path, uid, gid})
		return nil
	}

	opts := chvOpts(t)
	runDir := t.TempDir()
	workspaceDir := t.TempDir()
	if err := chvPrepareVirtiofsdOwnership(runDir, workspaceDir, opts.VirtiofsdUID, opts.VirtiofsdGID); err != nil {
		t.Fatalf("chvPrepareVirtiofsdOwnership: %v", err)
	}

	if len(calls) != 2 {
		t.Fatalf("chvChown called %d times, want 2: %+v", len(calls), calls)
	}
	seen := map[string]bool{}
	for _, c := range calls {
		seen[c.path] = true
		if c.uid == 0 || c.gid == 0 {
			t.Errorf("chown %q to %d:%d — must never chown to root", c.path, c.uid, c.gid)
		}
		if c.uid != opts.VirtiofsdUID || c.gid != opts.VirtiofsdGID {
			t.Errorf("chown %q to %d:%d, want %d:%d", c.path, c.uid, c.gid, opts.VirtiofsdUID, opts.VirtiofsdGID)
		}
	}
	if !seen[runDir] {
		t.Errorf("runDir %q was never chowned; got calls %+v", runDir, calls)
	}
	if !seen[workspaceDir] {
		t.Errorf("workspaceDir %q was never chowned; got calls %+v", workspaceDir, calls)
	}
}

// TestRestorePreparesVirtiofsdOwnershipPropagatesFailure covers the error
// path: if the underlying chown fails (e.g. the real EACCES/EPERM a non-root
// launcher process would hit trying to chown a path it does not own), that
// failure must propagate rather than being swallowed — a silently-skipped
// chown would reintroduce exactly the bug this fix closes.
func TestRestorePreparesVirtiofsdOwnershipPropagatesFailure(t *testing.T) {
	orig := chvChown
	defer func() { chvChown = orig }()
	chvChown = func(path string, uid, gid int) error {
		return os.ErrPermission
	}
	opts := chvOpts(t)
	err := chvPrepareVirtiofsdOwnership(t.TempDir(), t.TempDir(), opts.VirtiofsdUID, opts.VirtiofsdGID)
	if err == nil {
		t.Fatal("chvPrepareVirtiofsdOwnership swallowed a chown failure")
	}
}

// TestRestoreCallsPrepareOwnership covers fix round 2: the two tests above
// call chvPrepareVirtiofsdOwnership directly and never exercise Restore, so
// they cannot tell whether Restore actually calls it, or with which uid/gid.
// A mutation that changed Restore's call site to chown to 0:0 (undoing the
// whole round-1 fix) or removed the call entirely still passed every
// existing test — nothing was watching the call site inside Restore itself.
//
// This test drives Restore and observes that call site via chvPrepareOwnership
// (the indirected var), substituting a recorder that returns an error. That
// error makes Restore abort right there — before any process spawn, so no
// binaries and no KVM are needed — and lets this test assert against the
// exact arguments Restore passed, and against Restore's own return-value
// invariant (non-nil error, nil VM) on that path.
func TestRestoreCallsPrepareOwnership(t *testing.T) {
	orig := chvPrepareOwnership
	defer func() { chvPrepareOwnership = orig }()

	type call struct {
		runDir, workspaceDir string
		uid, gid             int
	}
	var got []call
	sentinel := errors.New("sentinel: ownership prep refused")
	chvPrepareOwnership = func(runDir, workspaceDir string, uid, gid int) error {
		got = append(got, call{runDir, workspaceDir, uid, gid})
		return sentinel
	}

	opts := chvOpts(t)
	lc, err := NewCloudHypervisorLauncher(opts)
	if err != nil {
		t.Fatalf("NewCloudHypervisorLauncher: %v", err)
	}
	workspaceDir := t.TempDir()
	vm, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-chv-ownership", Key: "run-a", WorkspaceDir: workspaceDir, GuestRAMBytes: 256 << 20,
	})

	// Restore's own invariant: never a non-nil VM alongside a non-nil error.
	if err == nil {
		t.Fatal("Restore returned nil error despite chvPrepareOwnership failing")
	}
	if vm != nil {
		t.Fatalf("Restore returned a non-nil VM alongside an error: %v", vm)
	}
	if !errors.Is(err, sentinel) {
		t.Fatalf("Restore's error does not wrap the sentinel: %v", err)
	}

	// Kills "removed the call entirely" (mutation 3): if Restore never calls
	// chvPrepareOwnership, got stays empty and this fails.
	if len(got) != 1 {
		t.Fatalf("chvPrepareOwnership called %d times via Restore, want 1: %+v", len(got), got)
	}
	c := got[0]

	// Kills "chown to 0:0" (mutation 2): asserting against opts.VirtiofsdUID/GID
	// alone would be self-referential if Restore hardcoded some OTHER non-zero
	// value, so also assert directly against zero.
	if c.uid == 0 || c.gid == 0 {
		t.Fatalf("Restore called chvPrepareOwnership with uid:gid %d:%d — must never be root", c.uid, c.gid)
	}
	if c.uid != opts.VirtiofsdUID || c.gid != opts.VirtiofsdGID {
		t.Fatalf("Restore called chvPrepareOwnership with %d:%d, want configured %d:%d", c.uid, c.gid, opts.VirtiofsdUID, opts.VirtiofsdGID)
	}

	// The paths must be the run dir Restore itself created for this VM (a
	// per-VM child of opts.RunDir keyed by req.ID) and req.WorkspaceDir, not
	// something else entirely — e.g. opts.RunDir itself, or opts.SnapshotDir.
	wantRunDir := filepath.Join(opts.RunDir, "vm-chv-ownership")
	if c.runDir != wantRunDir {
		t.Fatalf("runDir passed to chvPrepareOwnership = %q, want %q", c.runDir, wantRunDir)
	}
	if c.workspaceDir != workspaceDir {
		t.Fatalf("workspaceDir passed to chvPrepareOwnership = %q, want %q", c.workspaceDir, workspaceDir)
	}
}

// TestRestoreChecksWorkspaceReachableBeforeVirtiofsd covers fix round 3, item
// 2's wiring: Restore must call the reachability check (via the indirected
// chvCheckWorkspaceReachable) with req.WorkspaceDir and the configured
// VirtiofsdUID/GID, and must abort — before any process spawn, so no binaries
// and no KVM are needed — if that check fails. Mirrors
// TestRestoreCallsPrepareOwnership's structure exactly, for the same reason:
// without this, a mutation that deleted the call site, or passed the wrong
// path/uid/gid, would pass every other test in this file.
func TestRestoreChecksWorkspaceReachableBeforeVirtiofsd(t *testing.T) {
	origCheck := chvCheckWorkspaceReachable
	defer func() { chvCheckWorkspaceReachable = origCheck }()

	// chvPrepareOwnership runs just before this check and, for real, calls
	// os.Chown(..., VirtiofsdUID, VirtiofsdGID) — as a non-root test runner
	// that chown itself fails with "operation not permitted" before Restore
	// ever reaches the code under test here (see
	// TestRestorePreparesVirtiofsdOwnershipPropagatesFailure's own doc comment
	// for the identical, already-documented limitation). Stub it out so this
	// test exercises only the reachability-check wiring, not real chown.
	origPrepare := chvPrepareOwnership
	defer func() { chvPrepareOwnership = origPrepare }()
	chvPrepareOwnership = func(runDir, workspaceDir string, uid, gid int) error { return nil }

	type call struct {
		path     string
		uid, gid uint32
	}
	var got []call
	sentinel := errors.New("sentinel: workspace unreachable")
	chvCheckWorkspaceReachable = func(path string, uid, gid uint32) error {
		got = append(got, call{path, uid, gid})
		return sentinel
	}

	opts := chvOpts(t)
	lc, err := NewCloudHypervisorLauncher(opts)
	if err != nil {
		t.Fatalf("NewCloudHypervisorLauncher: %v", err)
	}
	workspaceDir := t.TempDir()
	vm, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-chv-reachable", Key: "run-a", WorkspaceDir: workspaceDir, GuestRAMBytes: 256 << 20,
	})

	// Restore's own invariant: never a non-nil VM alongside a non-nil error.
	if err == nil {
		t.Fatal("Restore returned nil error despite chvCheckWorkspaceReachable failing")
	}
	if vm != nil {
		t.Fatalf("Restore returned a non-nil VM alongside an error: %v", vm)
	}
	if !errors.Is(err, sentinel) {
		t.Fatalf("Restore's error does not wrap the sentinel: %v", err)
	}

	if len(got) != 1 {
		t.Fatalf("chvCheckWorkspaceReachable called %d times via Restore, want 1: %+v", len(got), got)
	}
	c := got[0]
	if c.path != workspaceDir {
		t.Fatalf("chvCheckWorkspaceReachable called with path %q, want %q", c.path, workspaceDir)
	}
	if c.uid != uint32(opts.VirtiofsdUID) || c.gid != uint32(opts.VirtiofsdGID) {
		t.Fatalf("chvCheckWorkspaceReachable called with %d:%d, want configured %d:%d",
			c.uid, c.gid, opts.VirtiofsdUID, opts.VirtiofsdGID)
	}
}

// TestRestoreFailsWhenWorkspaceIsUnreachable is fix round 3, item 2's
// mutation test run for real, through the actual Restore entry point rather
// than the seam above: a genuine 0700 ancestor above workspaceDir, owned by
// this test's own uid (never chvOpts's VirtiofsdUID 65534), reproduces exactly
// the rig's failure shape without needing virtiofsd, cloud-hypervisor, or
// root — the check runs and fails before any binary is exec'd. Asserts the
// resulting error names the blocking ancestor, so a reader gets the
// coordinator's ask ("which path, which uid, and which ancestor's mode is
// blocking") instead of virtiofsd's own misleading "does not exist".
func TestRestoreFailsWhenWorkspaceIsUnreachable(t *testing.T) {
	// chvPrepareOwnership runs just before the reachability check under test
	// and, for real, calls os.Chown(..., VirtiofsdUID, VirtiofsdGID) — as a
	// non-root test runner that chown itself fails with "operation not
	// permitted" before Restore ever reaches the check this test targets (see
	// TestRestorePreparesVirtiofsdOwnershipPropagatesFailure's own doc comment
	// for the identical, already-documented limitation). Stub it out so the
	// real chvCheckWorkspaceReachable (not faked here — this test exercises it
	// for real) is what actually fails Restore.
	origPrepare := chvPrepareOwnership
	defer func() { chvPrepareOwnership = origPrepare }()
	chvPrepareOwnership = func(runDir, workspaceDir string, uid, gid int) error { return nil }

	opts := chvOpts(t)
	lc, err := NewCloudHypervisorLauncher(opts)
	if err != nil {
		t.Fatalf("NewCloudHypervisorLauncher: %v", err)
	}

	blocker := filepath.Join(t.TempDir(), "blocker")
	workspaceDir := filepath.Join(blocker, "workspace")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		t.Fatalf("MkdirAll %s: %v", workspaceDir, err)
	}
	if err := os.Chmod(blocker, 0o700); err != nil {
		t.Fatalf("chmod %s to 0700: %v", blocker, err)
	}

	vm, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-chv-unreachable", Key: "run-a", WorkspaceDir: workspaceDir, GuestRAMBytes: 256 << 20,
	})
	if err == nil {
		t.Fatal("Restore with an unreachable workspace: want error, got nil")
	}
	if vm != nil {
		t.Fatalf("Restore returned a non-nil VM alongside an error: %v", vm)
	}
	for _, want := range []string{blocker, "0700", "65534"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("Restore error %q: missing %q", err.Error(), want)
		}
	}
}

// TestChvPrepareVirtiofsdOwnershipChmodsRunDir covers fix round 11's active
// fix: chvPrepareVirtiofsdOwnership must chmod runDir to 0700 (owner
// write+execute) in addition to chowning it, and must NOT chmod workspaceDir
// (that directory belongs to the pool/orchestration layer, not this
// launcher — see chvPrepareVirtiofsdOwnership's own doc comment for why
// workspaceDir gets chown but never chmod).
//
// Like TestRestorePreparesVirtiofsdOwnership, this substitutes both indirected
// seams (chvChown and chvChmod) rather than depending on the real syscalls:
// chvChown needs no root here only because it is faked, and chvChmod's real
// form would actually succeed against a t.TempDir() (this test process owns
// it) but faking it keeps this test about the CALL, consistent with its
// sibling.
func TestChvPrepareVirtiofsdOwnershipChmodsRunDir(t *testing.T) {
	origChown := chvChown
	origChmod := chvChmod
	defer func() { chvChown = origChown; chvChmod = origChmod }()
	chvChown = func(path string, uid, gid int) error { return nil }

	type call struct {
		path string
		mode os.FileMode
	}
	var calls []call
	chvChmod = func(path string, mode os.FileMode) error {
		calls = append(calls, call{path, mode})
		return nil
	}

	opts := chvOpts(t)
	runDir := t.TempDir()
	workspaceDir := t.TempDir()
	if err := chvPrepareVirtiofsdOwnership(runDir, workspaceDir, opts.VirtiofsdUID, opts.VirtiofsdGID); err != nil {
		t.Fatalf("chvPrepareVirtiofsdOwnership: %v", err)
	}

	if len(calls) != 1 {
		t.Fatalf("chvChmod called %d times, want 1: %+v", len(calls), calls)
	}
	if calls[0].path != runDir {
		t.Fatalf("chvChmod called on %q, want runDir %q", calls[0].path, runDir)
	}
	if calls[0].mode != 0o700 {
		t.Fatalf("chvChmod called with mode %v, want 0700", calls[0].mode)
	}
	for _, c := range calls {
		if c.path == workspaceDir {
			t.Fatalf("chvChmod must never touch workspaceDir (not this launcher's directory), but it was called on %q", c.path)
		}
	}
}

// TestChvPrepareVirtiofsdOwnershipPropagatesChmodFailure mirrors
// TestRestorePreparesVirtiofsdOwnershipPropagatesFailure for the new chmod
// step: a chmod failure must abort chvPrepareVirtiofsdOwnership rather than
// being swallowed, which would silently reintroduce the unverified-writability
// gap this fix round closes.
func TestChvPrepareVirtiofsdOwnershipPropagatesChmodFailure(t *testing.T) {
	origChown := chvChown
	origChmod := chvChmod
	defer func() { chvChown = origChown; chvChmod = origChmod }()
	chvChown = func(path string, uid, gid int) error { return nil }
	chvChmod = func(path string, mode os.FileMode) error { return os.ErrPermission }

	opts := chvOpts(t)
	err := chvPrepareVirtiofsdOwnership(t.TempDir(), t.TempDir(), opts.VirtiofsdUID, opts.VirtiofsdGID)
	if err == nil {
		t.Fatal("chvPrepareVirtiofsdOwnership swallowed a chmod failure")
	}
}

// TestRestoreCallsCheckSocketDirWritable covers fix round 11's wiring: Restore
// must call the new writability check (via the indirected
// chvCheckSocketDirWritable) with runDir and the configured VirtiofsdUID/GID,
// and must abort — before any process spawn, so no binaries and no KVM are
// needed — if that check fails. Mirrors TestRestoreChecksWorkspaceReachableBeforeVirtiofsd's
// structure exactly, for the same reason: without this, a mutation that
// deleted the call site, or passed the wrong path/uid/gid (e.g.
// req.WorkspaceDir instead of runDir), would pass every other test in this
// file.
func TestRestoreCallsCheckSocketDirWritable(t *testing.T) {
	// Bypass the two checks upstream of the one under test, for the same
	// documented reasons their own tests bypass their upstream neighbors: real
	// chown fails non-root, and real ancestor-reachability of a t.TempDir()
	// workspace depends on this machine's own temp-directory layout, neither of
	// which this test is about.
	origPrepare := chvPrepareOwnership
	origReachable := chvCheckWorkspaceReachable
	defer func() { chvPrepareOwnership = origPrepare; chvCheckWorkspaceReachable = origReachable }()
	chvPrepareOwnership = func(runDir, workspaceDir string, uid, gid int) error { return nil }
	chvCheckWorkspaceReachable = func(path string, uid, gid uint32) error { return nil }

	origWritable := chvCheckSocketDirWritable
	defer func() { chvCheckSocketDirWritable = origWritable }()

	type call struct {
		path     string
		uid, gid uint32
	}
	var got []call
	sentinel := errors.New("sentinel: socket dir not writable")
	chvCheckSocketDirWritable = func(path string, uid, gid uint32) error {
		got = append(got, call{path, uid, gid})
		return sentinel
	}

	opts := chvOpts(t)
	lc, err := NewCloudHypervisorLauncher(opts)
	if err != nil {
		t.Fatalf("NewCloudHypervisorLauncher: %v", err)
	}
	workspaceDir := t.TempDir()
	vm, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-chv-socket-writable", Key: "run-a", WorkspaceDir: workspaceDir, GuestRAMBytes: 256 << 20,
	})

	if err == nil {
		t.Fatal("Restore returned nil error despite chvCheckSocketDirWritable failing")
	}
	if vm != nil {
		t.Fatalf("Restore returned a non-nil VM alongside an error: %v", vm)
	}
	if !errors.Is(err, sentinel) {
		t.Fatalf("Restore's error does not wrap the sentinel: %v", err)
	}

	if len(got) != 1 {
		t.Fatalf("chvCheckSocketDirWritable called %d times via Restore, want 1: %+v", len(got), got)
	}
	c := got[0]
	wantRunDir := filepath.Join(opts.RunDir, "vm-chv-socket-writable")
	if c.path != wantRunDir {
		t.Fatalf("chvCheckSocketDirWritable called with path %q, want runDir %q (not workspaceDir %q)", c.path, wantRunDir, workspaceDir)
	}
	if c.uid != uint32(opts.VirtiofsdUID) || c.gid != uint32(opts.VirtiofsdGID) {
		t.Fatalf("chvCheckSocketDirWritable called with %d:%d, want configured %d:%d",
			c.uid, c.gid, opts.VirtiofsdUID, opts.VirtiofsdGID)
	}
}

// TestRestoreFailsWhenSocketDirNotWritable is fix round 11's mutation test run
// for real, through the actual Restore entry point rather than the seam
// above: runDir is created by Restore's own os.MkdirAll(runDir, 0o700), owned
// by this test's own uid — never chvOpts's VirtiofsdUID 65534 — so the real
// chvCheckSocketDirWritable (checkPathWritableBy) must refuse it exactly as
// virtiofsd itself would fail to create its socket and ".pid" sidecar file
// there. This reproduces the rig's failure shape ("Error creating pid file
// ...: Permission denied") without root, virtiofsd, or cloud-hypervisor.
//
// chvPrepareOwnership is stubbed out because its real chown to VirtiofsdUID
// fails non-root before Restore ever reaches the check under test (same
// documented limitation as TestRestoreFailsWhenWorkspaceIsUnreachable);
// critically, that stub is what leaves runDir's mode at MkdirAll's untouched
// 0700 for this test to observe — a real chvPrepareOwnership would have
// chmod'd it, just not to a mode uid 65534 could write into as "other" either,
// since chmod alone cannot make a directory this test owns writable by uid
// 65534 without root. chvCheckWorkspaceReachable is likewise stubbed to nil so
// this test is about socket-dir writability specifically, not workspace
// ancestor traversal (already covered by TestRestoreFailsWhenWorkspaceIsUnreachable).
func TestRestoreFailsWhenSocketDirNotWritable(t *testing.T) {
	origPrepare := chvPrepareOwnership
	origReachable := chvCheckWorkspaceReachable
	defer func() { chvPrepareOwnership = origPrepare; chvCheckWorkspaceReachable = origReachable }()
	chvPrepareOwnership = func(runDir, workspaceDir string, uid, gid int) error { return nil }
	chvCheckWorkspaceReachable = func(path string, uid, gid uint32) error { return nil }

	opts := chvOpts(t)
	lc, err := NewCloudHypervisorLauncher(opts)
	if err != nil {
		t.Fatalf("NewCloudHypervisorLauncher: %v", err)
	}
	workspaceDir := t.TempDir()

	vm, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-chv-socket-unwritable", Key: "run-a", WorkspaceDir: workspaceDir, GuestRAMBytes: 256 << 20,
	})
	if err == nil {
		t.Fatal("Restore with a socket dir not writable by the configured uid: want error, got nil")
	}
	if vm != nil {
		t.Fatalf("Restore returned a non-nil VM alongside an error: %v", vm)
	}
	wantRunDir := filepath.Join(opts.RunDir, "vm-chv-socket-unwritable")
	for _, want := range []string{wantRunDir, "0700", "65534"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("Restore error %q: missing %q", err.Error(), want)
		}
	}
}

// TestDestroyRemovesVirtiofsdPidFile covers deliverable (d) of fix round 11
// honestly: rather than adding new cleanup code for virtiofsd's
// "<socket>.pid" sidecar file, this proves the cleanup Destroy() already has —
// os.RemoveAll(v.runDir), wholesale, unconditionally — already removes it, the
// same way it already removes cloud-hypervisor's own ".sock.lock" and every
// other file virtiofsd or cloud-hypervisor drop into runDir. No literal
// "*.sock.lock" or "*.pid" handling exists anywhere in this file; runDir's
// entire contents are disposable by construction, and this test pins that
// invariant so a future change narrowing Destroy's cleanup (e.g. switching
// from RemoveAll to removing a fixed list of known filenames) would be caught
// here rather than resurfacing as a leaked .pid file on a real rig.
func TestDestroyRemovesVirtiofsdPidFile(t *testing.T) {
	runDir := t.TempDir()
	pidFile := filepath.Join(runDir, "vfsd.sock.pid")
	if err := os.WriteFile(pidFile, []byte("12345\n"), 0o644); err != nil {
		t.Fatalf("WriteFile %s: %v", pidFile, err)
	}

	v := &chvVM{id: "vm-chv-pid-cleanup", key: "run-a", runDir: runDir}
	if err := v.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}

	if _, err := os.Stat(runDir); !os.IsNotExist(err) {
		t.Fatalf("runDir %s still exists after Destroy (stat err: %v); virtiofsd's .pid file would leak", runDir, err)
	}
}

func TestCloudHypervisorRestoresPausedAndRunsOneCommand(t *testing.T) {
	requireKVM(t)
	if _, err := exec.LookPath(chvOpts(t).CHVBin); err != nil {
		t.Skipf("cloud-hypervisor not installed: %v", err)
	}
	lc, err := NewCloudHypervisorLauncher(chvOpts(t))
	if err != nil {
		t.Fatalf("NewCloudHypervisorLauncher: %v", err)
	}
	dir := t.TempDir()
	vm, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-chv-1", Key: "run-a", WorkspaceDir: dir, GuestRAMBytes: 256 << 20,
	})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	defer func() { _ = vm.Destroy() }()
	if err := vm.Resume(context.Background()); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	var out capturingSink
	if _, err := vm.Run(context.Background(), Command{Command: "echo hi > f; cat f", TimeoutS: 30, CapBytes: OutputCapBytes}, &out); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out.out() != "hi\n" {
		t.Fatalf("stdout = %q", out.out())
	}
	// virtio-fs means the HOST filesystem is the authority, so the write is already
	// durable with no sync anywhere — spec §4.3's "nothing is lost" row, which is also
	// why the write-durability gate cannot fail on this arm for a missing sync.
	if b, err := os.ReadFile(dir + "/f"); err != nil || string(b) != "hi\n" {
		t.Fatalf("host-side file = %q err=%v", b, err)
	}
}

func TestCloudHypervisorSupportsTwoStandbysForOneRun(t *testing.T) {
	requireKVM(t)
	if _, err := exec.LookPath(chvOpts(t).CHVBin); err != nil {
		t.Skipf("cloud-hypervisor not installed: %v", err)
	}
	lc, _ := NewCloudHypervisorLauncher(chvOpts(t))
	dir := t.TempDir()
	// The row that decides the arm: D>1 pre-mounted standbys, which the Firecracker arm
	// cannot have at all (spec §4.3).
	var vms []VM
	for _, id := range []string{"vm-chv-a", "vm-chv-b"} {
		vm, err := lc.Restore(context.Background(), RestoreRequest{ID: id, Key: "run-a", WorkspaceDir: dir, GuestRAMBytes: 256 << 20})
		if err != nil {
			t.Fatalf("Restore %s: %v", id, err)
		}
		defer func() { _ = vm.Destroy() }()
		vms = append(vms, vm)
	}
	for i, vm := range vms {
		if err := vm.Resume(context.Background()); err != nil {
			t.Fatalf("Resume %d: %v", i, err)
		}
	}
	// Both resumed, both mounted, no corruption: run in each, concurrently.
	errs := make(chan error, len(vms))
	for i, vm := range vms {
		go func(i int, vm VM) {
			_, err := vm.Run(context.Background(), Command{
				Command: "echo " + string(rune('a'+i)) + " > f" + string(rune('a'+i)), TimeoutS: 30, CapBytes: OutputCapBytes,
			}, &capturingSink{})
			errs <- err
		}(i, vm)
	}
	for range vms {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent Run: %v", err)
		}
	}
	for _, n := range []string{"fa", "fb"} {
		if _, err := os.Stat(dir + "/" + n); err != nil {
			t.Fatalf("%s missing: %v", n, err)
		}
	}
}

// chvFakeVMMScript writes a tiny python3 script to dir/name that argv-parses
// "--log-file <path>" out of its own command line (chvVMMArgv's own shape:
// "--log-file" and the path are two SEPARATE argv elements, not
// "--log-file=<path>" — this script must match that, not virtiofsd's "=" style
// below), writes marker into that path itself, then sleeps — standing in for
// cloud-hypervisor in TestRestoreFoldsCloudHypervisorsOwnLogIntoTimeoutError. It
// deliberately never creates the api.sock cloud-hypervisor would normally expose,
// so Restore's own waitForUnixSocket(ctx, apiSock, ...) times out for real and
// exercises Restore's actual error-formatting code, not a stand-in for it.
func chvFakeVMMScript(t *testing.T, dir, name, marker string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	script := "#!/usr/bin/env python3\n" +
		"import sys, time\n" +
		"argv = sys.argv[1:]\n" +
		"log_path = None\n" +
		"for i, a in enumerate(argv):\n" +
		"    if a == '--log-file' and i + 1 < len(argv):\n" +
		"        log_path = argv[i + 1]\n" +
		"if log_path:\n" +
		"    with open(log_path, 'w') as f:\n" +
		"        f.write(" + strconv.Quote(marker) + " + chr(10))\n" +
		"time.sleep(60)\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake vmm script %s: %v", path, err)
	}
	return path
}

// chvFakeVirtiofsdScript writes a tiny python3 script to dir/name that
// argv-parses "--socket-path=<path>" (virtiofsd's own "=" style, per
// virtiofsdArgv — NOT chvFakeVMMScript's two-separate-args style above), binds
// and listens a real AF_UNIX socket there so Restore's own
// waitForUnixSocket(ctx, fsSock, ...) succeeds exactly as it would against the
// real virtiofsd, then sleeps. It never has to speak vhost-user for real: this
// test's fake cloud-hypervisor (chvFakeVMMScript) never gets far enough to try
// — it fails its OWN api.sock wait first.
func chvFakeVirtiofsdScript(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	script := "#!/usr/bin/env python3\n" +
		"import socket, sys, time\n" +
		"sock_path = None\n" +
		"for a in sys.argv[1:]:\n" +
		"    if a.startswith('--socket-path='):\n" +
		"        sock_path = a.split('=', 1)[1]\n" +
		"if not sock_path:\n" +
		"    sys.exit(1)\n" +
		"s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n" +
		"s.bind(sock_path)\n" +
		"s.listen(1)\n" +
		"time.sleep(60)\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake virtiofsd script %s: %v", path, err)
	}
	return path
}

// TestRestoreFoldsCloudHypervisorsOwnLogIntoTimeoutError is fix round 12's
// (task-16 report) end-to-end half of the test deliverable: TestChvVMMArgvCarriesItsOwnLogFile
// above proves chvVMMArgv itself hands cloud-hypervisor a --log-file argument
// that survives the systemd-run wrap; THIS test proves the other half of the
// same claim through the real Restore() entry point — that whatever
// cloud-hypervisor writes to that file actually lands inside a real error
// Restore returns, not just inside the argv it was given.
//
// Real cloud-hypervisor and real virtiofsd binaries are replaced with tiny
// python3 scripts (chvFakeVirtiofsdScript, chvFakeVMMScript) rather than the
// genuine articles, for a reason specific to THIS test, not a general
// convenience: the point here is Restore's own output-capture and
// error-formatting code, which needs a process that behaves like cloud-hypervisor
// just enough to reach and then fail the api.sock wait — it does not need a
// process that can actually restore a VM. TestCloudHypervisorRestoresPausedAndRunsOneCommand
// and its neighbours below already cover the real binaries end to end, gated on
// requireKVM.
//
// THIS test's own gate is deliberately NOT requireKVM: it never touches
// /dev/kvm (neither fake script is a hypervisor), so gating it on SH_KVM would
// be gating it on the wrong resource and would report the wrong reason if it
// were ever skipped. Its real, and only, unmet local dependency is ROOT:
// chvIsolateAndDropPrivilegesPlatform (launcher_chv_unix.go) sets
// SysProcAttr.Credential UNCONDITIONALLY whenever both uid and gid it is given
// are nonzero, and Restore always calls it for the virtiofsd process with
// VirtiofsdUID/VirtiofsdGID — 65534 here, same as chvOpts(t) elsewhere in this
// file — so starting even this fake virtiofsd script requires CAP_SETUID/root
// on this test binary's own process, exactly as the real virtiofsd would. The
// coordinator's rig has this (it already needs root for jailer and for
// virtiofsd's real privileged operations); this task's own dev environment does
// not, and does not have KVM either — but this is the one test in this file
// whose specific missing capability is root, not KVM, and it is named that way
// here and in the task-16 report specifically so the two are not conflated.
//
// chvPrepareOwnership, chvCheckWorkspaceReachable, and chvCheckSocketDirWritable
// are all stubbed to a no-op success, mirroring TestRestoreFailsWhenSocketDirNotWritable's
// and TestRestoreCallsCheckSocketDirWritable's own documented reason for doing
// the same: this test is about the cloud-hypervisor output-capture path
// downstream of them, not about re-litigating checks three other tests already
// cover, and their REAL implementations would need root of their own kind (a
// real chown to uid 65534) that has nothing to do with the claim under test
// here.
func TestRestoreFoldsCloudHypervisorsOwnLogIntoTimeoutError(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root: chvIsolateAndDropPrivilegesPlatform sets SysProcAttr.Credential " +
			"unconditionally for virtiofsd's fake stand-in (uid/gid 65534), which requires " +
			"CAP_SETUID/root — NOT /dev/kvm, which this test never touches")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skipf("python3 not installed: %v", err)
	}

	origPrepare := chvPrepareOwnership
	origReachable := chvCheckWorkspaceReachable
	origWritable := chvCheckSocketDirWritable
	defer func() {
		chvPrepareOwnership = origPrepare
		chvCheckWorkspaceReachable = origReachable
		chvCheckSocketDirWritable = origWritable
	}()
	chvPrepareOwnership = func(runDir, workspaceDir string, uid, gid int) error { return nil }
	chvCheckWorkspaceReachable = func(path string, uid, gid uint32) error { return nil }
	chvCheckSocketDirWritable = func(path string, uid, gid uint32) error { return nil }

	const marker = "ROUND12-FAKE-CLOUD-HYPERVISOR-SAYS-THIS-DISTINCTIVE-MARKER"

	scriptDir := t.TempDir()
	fakeVirtiofsd := chvFakeVirtiofsdScript(t, scriptDir, "fake-virtiofsd.py")
	fakeCHV := chvFakeVMMScript(t, scriptDir, "fake-cloud-hypervisor.py", marker)

	// A fresh, self-contained golden snapshot dir — deliberately NOT chvOpts(t)'s
	// (which may point at a real rig SH_SNAPSHOT_IMAGE_DIR): this test writes its
	// own golden files under the exact golden names chvStageSnapshotFiles reads
	// (chvGoldenVMState/chvGoldenMemFile/chvGoldenConfigFile), the same synthetic
	// shape TestRestoreStagesCHNativeNamesFromGoldenNames already uses, and must
	// never risk writing into a real shared snapshot directory.
	snapshotDir := t.TempDir()
	goldenConfig := `{
		"vsock": {"cid": 3, "socket": "/golden/vsock.sock"},
		"fs": [{"tag": "workspace", "socket": "/golden/vfsd.sock", "num_queues": 1, "queue_size": 1024}],
		"disks": [{"path": "/golden/rootfs.ext4", "readonly": true}]
	}`
	golden := map[string]string{
		chvGoldenVMState:    "fake vmstate bytes",
		chvGoldenMemFile:    "fake memfile bytes",
		chvGoldenConfigFile: goldenConfig,
	}
	for name, content := range golden {
		if err := os.WriteFile(filepath.Join(snapshotDir, name), []byte(content), 0o600); err != nil {
			t.Fatalf("seed golden %s: %v", name, err)
		}
	}

	opts := CHVOptions{
		SnapshotDir:  snapshotDir,
		CHVBin:       fakeCHV,
		ChRemoteBin:  "/usr/bin/ch-remote", // never reached: Restore fails at the api.sock wait first
		VirtiofsdBin: fakeVirtiofsd,
		RunDir:       sameDeviceSiblingDir(t, snapshotDir),
		VirtiofsdUID: 65534,
		VirtiofsdGID: 65534,
		VsockPort:    1024,
	}

	lc, err := NewCloudHypervisorLauncher(opts)
	if err != nil {
		t.Fatalf("NewCloudHypervisorLauncher: %v", err)
	}

	vm, err := lc.Restore(context.Background(), RestoreRequest{
		ID: "vm-chv-fake-log", Key: "run-a", WorkspaceDir: t.TempDir(), GuestRAMBytes: 256 << 20,
	})
	if err == nil {
		defer func() { _ = vm.Destroy() }()
		t.Fatal("Restore with a fake cloud-hypervisor that never creates api.sock: want error, got nil")
	}
	if vm != nil {
		t.Fatalf("Restore returned a non-nil VM alongside an error: %v", vm)
	}

	// The decisive assertion: this is the whole point of round 12. Before the fix,
	// this marker had nowhere to go — vmmCmd.Stdout/Stderr (the OLD, sole capture)
	// only ever captured whatever process exec.Cmd directly spawned, and even
	// unwrapped (no ParentCgroup here) that file would hold nothing cloud-hypervisor
	// itself wrote via --log-file. Now chvLogPath is opened and written by the fake
	// VMM itself, and Restore's own timeout-error formatting
	// (chvReadConsole(chvLogPath)) must fold that content into the error this test
	// receives.
	if !strings.Contains(err.Error(), marker) {
		t.Fatalf("Restore error does not contain cloud-hypervisor's own --log-file words:\n%v", err)
	}
}

// TestRewriteSnapshotConfigGivesEachVMItsOwnSockets is not part of the brief's
// verbatim test list — it covers rewriteSnapshotConfig, a helper this task's own
// design added (see its doc comment in launcher_chv.go) to solve a problem neither
// the brief nor hardware-corrections spells out a mechanism for: config.json
// embeds its vsock (and virtio-fs) socket paths verbatim, so two standbys
// restored from the SAME golden config.json would otherwise collide binding the
// identical host-side Unix socket. This is the one piece of that design
// verifiable without KVM access — a pure JSON transform, run here against
// synthetic input shaped like the reference tutorial's documented config.json.
func TestRewriteSnapshotConfigGivesEachVMItsOwnSockets(t *testing.T) {
	golden := `{
		"payload": {"kernel": "/kernel", "cmdline": "console=hvc0"},
		"console": {"file": "/console.log", "mode": "File"},
		"vsock": {"cid": 3, "socket": "/golden/vsock.sock"},
		"fs": [{"tag": "workspace", "socket": "/golden/vfsd.sock", "num_queues": 1, "queue_size": 1024}],
		"disks": [{"path": "/rootfs", "readonly": true}]
	}`
	rootfsPath := "/srv/snapshots/swebench-py311-chv/rootfs"
	kernelPath := "/srv/snapshots/swebench-py311-chv/kernel"
	consolePath := "/run/vm-a/guest-console.log"
	out, err := rewriteSnapshotConfig([]byte(golden), "/run/vm-a/vsock.sock", "/run/vm-a/vfsd.sock", rootfsPath, kernelPath, consolePath)
	if err != nil {
		t.Fatalf("rewriteSnapshotConfig: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("result is not valid JSON: %v", err)
	}
	vsock, _ := doc["vsock"].(map[string]any)
	if got := vsock["socket"]; got != "/run/vm-a/vsock.sock" {
		t.Fatalf("vsock.socket = %v, want /run/vm-a/vsock.sock", got)
	}
	fsList, _ := doc["fs"].([]any)
	if len(fsList) != 1 {
		t.Fatalf("fs list = %v", fsList)
	}
	fs, _ := fsList[0].(map[string]any)
	if got := fs["socket"]; got != "/run/vm-a/vfsd.sock" {
		t.Fatalf("fs[0].socket = %v, want /run/vm-a/vfsd.sock", got)
	}
	// Fix round 13: payload.kernel MUST now be rewritten to the given absolute
	// kernelPath — CH's own log during a real restore proved this field IS
	// carried forward and acted on (see rewriteSnapshotConfig's doc comment for
	// the full correction of round 7's wrong "safe" conclusion).
	payload, _ := doc["payload"].(map[string]any)
	if got := payload["kernel"]; got != kernelPath {
		t.Fatalf("payload.kernel = %v, want rewritten to %v", got, kernelPath)
	}
	if got := payload["cmdline"]; got != "console=hvc0" {
		t.Fatalf("payload.cmdline = %v, want unchanged", got)
	}
	// Fix round 13: console.file MUST now be rewritten to the given per-VM
	// consolePath, not left at the golden jail-relative host-root value.
	console, _ := doc["console"].(map[string]any)
	if got := console["file"]; got != consolePath {
		t.Fatalf("console.file = %v, want rewritten to %v", got, consolePath)
	}
	if got := console["mode"]; got != "File" {
		t.Fatalf("console.mode = %v, want unchanged", got)
	}
	// Fix round 7: disks[].path MUST now be rewritten to the given absolute
	// rootfsPath — the golden snapshot's own jail-relative "/rootfs" resolves
	// against the HOST's real root once this launcher's unchrooted
	// cloud-hypervisor tries to open it, which is the exact "No such file or
	// directory" ch-remote restore reported on real hardware. readonly, in
	// contrast, MUST stay untouched: C4/C8 already settled that readonly=on
	// (baked into the golden snapshot by the build pipeline) is what makes the
	// disk lock shareable across standbys, and rewriting the path does not
	// change who owns that decision.
	disks, _ := doc["disks"].([]any)
	disk, _ := disks[0].(map[string]any)
	if got := disk["path"]; got != rootfsPath {
		t.Fatalf("disks[0].path = %v, want rewritten to %v", got, rootfsPath)
	}
	if got, ok := disk["readonly"].(bool); !ok || !got {
		t.Fatalf("disks[0].readonly = %v, want unchanged true", disk["readonly"])
	}
}

// TestRewriteSnapshotConfigRewritesEveryDiskToTheSharedGoldenPath is the
// assertion the coordinator's fix-round-7 ruling required: disks[].path must be
// absolute and point INTO the snapshot directory (never jail-relative like
// "/rootfs", never into a per-VM runDir), and — because every standby shares the
// identical golden rootfs file on purpose, unlike vsock/fs sockets — every disk
// entry in a multi-disk config.json must be rewritten to that SAME path, not a
// distinct one per entry.
func TestRewriteSnapshotConfigRewritesEveryDiskToTheSharedGoldenPath(t *testing.T) {
	golden := `{
		"vsock": {"cid": 3, "socket": "/golden/vsock.sock"},
		"disks": [
			{"path": "/rootfs", "readonly": true},
			{"path": "/rootfs", "readonly": true}
		]
	}`
	rootfsPath := "/srv/snapshots/swebench-py311-chv/rootfs"
	kernelPath := "/srv/snapshots/swebench-py311-chv/kernel"
	consolePath := "/run/vm-a/guest-console.log"
	out, err := rewriteSnapshotConfig([]byte(golden), "/run/vm-a/vsock.sock", "", rootfsPath, kernelPath, consolePath)
	if err != nil {
		t.Fatalf("rewriteSnapshotConfig: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("result is not valid JSON: %v", err)
	}
	disks, _ := doc["disks"].([]any)
	if len(disks) != 2 {
		t.Fatalf("disks = %v, want 2 entries", disks)
	}
	for i, entry := range disks {
		disk, _ := entry.(map[string]any)
		path, _ := disk["path"].(string)
		if path != rootfsPath {
			t.Fatalf("disks[%d].path = %q, want %q (every standby shares the one golden rootfs)", i, path, rootfsPath)
		}
		if !filepath.IsAbs(path) {
			t.Fatalf("disks[%d].path = %q, want an absolute path", i, path)
		}
		if path == "/rootfs" {
			t.Fatalf("disks[%d].path is still the jail-relative golden value %q — not rewritten", i, path)
		}
		if !strings.HasPrefix(path, "/srv/snapshots/swebench-py311-chv/") {
			t.Fatalf("disks[%d].path = %q, want it to point INTO the snapshot directory", i, path)
		}
	}
}

// TestRewriteSnapshotConfigToleratesNoFsSection covers a config.json with no
// virtio-fs device at all (fsSocketPath == "") — rewriteSnapshotConfig must not
// fail or invent an "fs" key that was not there.
func TestRewriteSnapshotConfigToleratesNoFsSection(t *testing.T) {
	golden := `{"vsock": {"cid": 3, "socket": "/golden/vsock.sock"}}`
	out, err := rewriteSnapshotConfig([]byte(golden), "/run/vm-a/vsock.sock", "", "/srv/snapshots/swebench-py311-chv/rootfs",
		"/srv/snapshots/swebench-py311-chv/kernel", "/run/vm-a/guest-console.log")
	if err != nil {
		t.Fatalf("rewriteSnapshotConfig: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("result is not valid JSON: %v", err)
	}
	if _, present := doc["fs"]; present {
		t.Fatalf("fs key should not have been invented: %v", doc["fs"])
	}
	if _, present := doc["disks"]; present {
		t.Fatalf("disks key should not have been invented: %v", doc["disks"])
	}
	// Fix round 13: payload/console keys must likewise not be invented when
	// absent from the golden config — this fixture has neither, mirroring the
	// existing fs/disks tolerance above.
	if _, present := doc["payload"]; present {
		t.Fatalf("payload key should not have been invented: %v", doc["payload"])
	}
	if _, present := doc["console"]; present {
		t.Fatalf("console key should not have been invented: %v", doc["console"])
	}
}

// TestRewriteSnapshotConfigRewritesKernelAndConsoleToHostPaths is fix round
// 13's required assertion pair: payload.kernel must be rewritten to an
// absolute path INSIDE the snapshot directory (the coordinator's captured CH
// log proved this field is read back during VmRestore, contradicting round
// 7's source-reading-only conclusion that it was safe to leave at its
// jail-relative golden value), and console.file must be rewritten to a path
// INSIDE the per-VM run directory — specifically NOT the golden jail-relative
// "/console.log", which resolves to the HOST's real root once this launcher's
// unchrooted cloud-hypervisor opens it.
func TestRewriteSnapshotConfigRewritesKernelAndConsoleToHostPaths(t *testing.T) {
	golden := `{
		"payload": {"kernel": "/kernel"},
		"console": {"file": "/console.log", "mode": "File"},
		"vsock": {"cid": 3, "socket": "/golden/vsock.sock"}
	}`
	snapshotDir := "/srv/snapshots/swebench-py311-chv"
	runDir := "/run/vm-a"
	kernelPath := filepath.Join(snapshotDir, "kernel")
	consolePath := filepath.Join(runDir, "guest-console.log")
	out, err := rewriteSnapshotConfig([]byte(golden), filepath.Join(runDir, "vsock.sock"), "", filepath.Join(snapshotDir, "rootfs"), kernelPath, consolePath)
	if err != nil {
		t.Fatalf("rewriteSnapshotConfig: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("result is not valid JSON: %v", err)
	}

	payload, _ := doc["payload"].(map[string]any)
	gotKernel, _ := payload["kernel"].(string)
	if !filepath.IsAbs(gotKernel) {
		t.Fatalf("payload.kernel = %q, want an absolute path", gotKernel)
	}
	if gotKernel == "/kernel" {
		t.Fatalf("payload.kernel is still the jail-relative golden value %q — not rewritten", gotKernel)
	}
	if !strings.HasPrefix(gotKernel, snapshotDir+string(filepath.Separator)) {
		t.Fatalf("payload.kernel = %q, want it to point INTO the snapshot directory %q", gotKernel, snapshotDir)
	}

	console, _ := doc["console"].(map[string]any)
	gotConsole, _ := console["file"].(string)
	if gotConsole == "/console.log" {
		t.Fatalf("console.file is still the golden host-root value %q — not rewritten", gotConsole)
	}
	if !filepath.IsAbs(gotConsole) {
		t.Fatalf("console.file = %q, want an absolute path", gotConsole)
	}
	if !strings.HasPrefix(gotConsole, runDir+string(filepath.Separator)) {
		t.Fatalf("console.file = %q, want it to point INTO the per-VM run directory %q, not host root", gotConsole, runDir)
	}
}

// TestRestoreStagesCHNativeNamesFromGoldenNames is the test the coordinator's
// round-4 ruling required: it exists because launcher_chv.go's Restore once read
// CH's own native names (config.json, memory-ranges, state.json) straight out of
// the golden SnapshotDir, but deploy/microvm/build-snapshot.sh's lock_down ships
// that same golden directory under the UNIFIED cross-VMM names (vmstate, memfile,
// ch-config.json) instead — so a real restore would have failed on a missing
// file, and nothing on this branch caught it because every prior test only
// asserted on the chvSnapshot*/chvGolden* constants, never on what actually landed
// on disk. This test populates a fake golden directory using the real golden
// names, runs the pure staging step, and inspects runDir directly: it must
// contain CH's native names (and only those — not the golden names) for
// vm.restore to have anything to replay.
func TestRestoreStagesCHNativeNamesFromGoldenNames(t *testing.T) {
	goldenDir := t.TempDir()
	runDir := t.TempDir()

	// Same synthetic shape as TestRewriteSnapshotConfigGivesEachVMItsOwnSockets,
	// reused here because chvStageSnapshotFiles' config path runs through the same
	// rewriteSnapshotConfig — the point of this test is the file-name translation
	// around it, not re-litigating the JSON rewrite itself.
	goldenConfig := `{
		"payload": {"kernel": "/kernel"},
		"console": {"file": "/console.log", "mode": "File"},
		"vsock": {"cid": 3, "socket": "/golden/vsock.sock"},
		"fs": [{"tag": "workspace", "socket": "/golden/vfsd.sock", "num_queues": 1, "queue_size": 1024}],
		"disks": [{"path": "/golden/rootfs.ext4", "readonly": true}]
	}`
	golden := map[string]string{
		chvGoldenVMState:    "fake vmstate bytes",
		chvGoldenMemFile:    "fake memfile bytes",
		chvGoldenConfigFile: goldenConfig,
	}
	for name, content := range golden {
		if err := os.WriteFile(filepath.Join(goldenDir, name), []byte(content), 0o600); err != nil {
			t.Fatalf("seed golden %s: %v", name, err)
		}
	}

	vsockSock := filepath.Join(runDir, "vsock.sock")
	fsSock := filepath.Join(runDir, "vfsd.sock")
	if err := chvStageSnapshotFiles(goldenDir, runDir, vsockSock, fsSock); err != nil {
		t.Fatalf("chvStageSnapshotFiles: %v", err)
	}

	// The decisive assertion: CH's native names must be PRESENT in runDir, by
	// filename, with the right content carried over from their golden counterpart —
	// not merely "the constants exist somewhere in the source".
	wantContent := map[string]string{
		chvSnapshotStateFile:    "fake vmstate bytes", // golden vmstate -> native state.json
		chvSnapshotMemoryRanges: "fake memfile bytes", // golden memfile -> native memory-ranges
	}
	for native, want := range wantContent {
		got, err := os.ReadFile(filepath.Join(runDir, native))
		if err != nil {
			t.Fatalf("runDir missing native file %q: %v", native, err)
		}
		if string(got) != want {
			t.Fatalf("runDir/%s content = %q, want %q", native, got, want)
		}
	}
	// config.json (native) must exist and be the REWRITTEN golden ch-config.json,
	// with this VM's own socket paths substituted in.
	cfg, err := os.ReadFile(filepath.Join(runDir, chvSnapshotConfigFile))
	if err != nil {
		t.Fatalf("runDir missing native %q: %v", chvSnapshotConfigFile, err)
	}
	var doc map[string]any
	if err := json.Unmarshal(cfg, &doc); err != nil {
		t.Fatalf("runDir/%s is not valid JSON: %v", chvSnapshotConfigFile, err)
	}
	if vsock, _ := doc["vsock"].(map[string]any); vsock["socket"] != vsockSock {
		t.Fatalf("runDir/%s vsock.socket = %v, want %v", chvSnapshotConfigFile, vsock["socket"], vsockSock)
	}

	// Fix round 7's required assertion: disks[].path in the rewritten config must
	// be absolute and point INTO the snapshot directory (goldenDir here stands in
	// for opts.SnapshotDir) — never the jail-relative golden value ("/golden/rootfs.ext4"
	// in this fixture, "/rootfs" for a real build), and never into runDir, since
	// every standby is meant to open the ONE shared golden rootfs file, not a
	// per-VM copy staged alongside its sockets.
	wantRootfsPath := filepath.Join(goldenDir, fileRootfs)
	disks, _ := doc["disks"].([]any)
	if len(disks) != 1 {
		t.Fatalf("runDir/%s disks = %v, want 1 entry", chvSnapshotConfigFile, disks)
	}
	disk, _ := disks[0].(map[string]any)
	gotPath, _ := disk["path"].(string)
	if gotPath != wantRootfsPath {
		t.Fatalf("runDir/%s disks[0].path = %q, want %q", chvSnapshotConfigFile, gotPath, wantRootfsPath)
	}
	if !filepath.IsAbs(gotPath) {
		t.Fatalf("runDir/%s disks[0].path = %q, want an absolute path", chvSnapshotConfigFile, gotPath)
	}
	if gotPath == "/golden/rootfs.ext4" || gotPath == "/rootfs" {
		t.Fatalf("runDir/%s disks[0].path is still the jail-relative golden value %q — not rewritten", chvSnapshotConfigFile, gotPath)
	}
	if strings.HasPrefix(gotPath, runDir) {
		t.Fatalf("runDir/%s disks[0].path = %q, want it to point into goldenDir/SnapshotDir, not into runDir", chvSnapshotConfigFile, gotPath)
	}
	if got, ok := disk["readonly"].(bool); !ok || !got {
		t.Fatalf("runDir/%s disks[0].readonly = %v, want unchanged true", chvSnapshotConfigFile, disk["readonly"])
	}

	// Fix round 13's required end-to-end assertions: chvStageSnapshotFiles must
	// compute payload.kernel and console.file itself (via fileKernel and
	// chvGuestConsoleLog) and pass them through rewriteSnapshotConfig, exactly
	// mirroring rootfsPath's existing treatment above — this is the integration
	// point neither TestRewriteSnapshotConfigRewritesKernelAndConsoleToHostPaths
	// nor any other pure-function test can exercise, since only
	// chvStageSnapshotFiles knows goldenDir/runDir and derives these two paths
	// internally rather than accepting them as parameters.
	wantKernelPath := filepath.Join(goldenDir, fileKernel)
	payload, _ := doc["payload"].(map[string]any)
	gotKernel, _ := payload["kernel"].(string)
	if gotKernel != wantKernelPath {
		t.Fatalf("runDir/%s payload.kernel = %q, want %q", chvSnapshotConfigFile, gotKernel, wantKernelPath)
	}
	if gotKernel == "/kernel" {
		t.Fatalf("runDir/%s payload.kernel is still the jail-relative golden value %q — not rewritten", chvSnapshotConfigFile, gotKernel)
	}

	wantConsolePath := filepath.Join(runDir, chvGuestConsoleLog)
	console, _ := doc["console"].(map[string]any)
	gotConsole, _ := console["file"].(string)
	if gotConsole != wantConsolePath {
		t.Fatalf("runDir/%s console.file = %q, want %q", chvSnapshotConfigFile, gotConsole, wantConsolePath)
	}
	if gotConsole == "/console.log" {
		t.Fatalf("runDir/%s console.file is still the golden host-root value %q — not rewritten", chvSnapshotConfigFile, gotConsole)
	}
	if !strings.HasPrefix(gotConsole, runDir) {
		t.Fatalf("runDir/%s console.file = %q, want it to point INTO runDir, not host root", chvSnapshotConfigFile, gotConsole)
	}

	// And the golden names themselves must NOT be the names runDir exposes to CH —
	// this is what actually catches a reversed or mis-pointed mapping, since a
	// broken mapping that merely renamed golden->golden would otherwise slip past
	// the assertions above.
	for _, goldenName := range []string{chvGoldenVMState, chvGoldenMemFile, chvGoldenConfigFile} {
		if goldenName == chvSnapshotConfigFile || goldenName == chvSnapshotMemoryRanges || goldenName == chvSnapshotStateFile {
			continue // names happen to collide; nothing to check
		}
		if _, err := os.Stat(filepath.Join(runDir, goldenName)); err == nil {
			t.Fatalf("runDir unexpectedly has a file under the GOLDEN name %q; vm.restore needs CH's native names", goldenName)
		}
	}
}

// TestChvWrapCommandMountsWorkspaceBeforeTheCommand is round 8's decisive test: the
// §8 gates (TestGateWriteDurability, TestGateNoCrossRunBleed) failed on real
// hardware because nothing mounted virtio-fs in the guest, and this is the pure,
// KVM-free slice of that fix that CAN be asserted here — the command string
// chvWrapCommand builds, not the real mount syscall.
//
// The tag and mount point are asserted as LITERAL strings ("workspace", "/workspace"),
// deliberately not via the chvWorkspaceTag/chvWorkspaceMountPoint constants: this is
// the host/guest contract build-snapshot.sh's `--fs tag=workspace,socket=...` flag
// is the other half of, so a rename of either constant that drifted away from that
// flag must fail this test loudly, rather than the test silently tracking whatever
// the constant currently says and proving nothing.
func TestChvWrapCommandMountsWorkspaceBeforeTheCommand(t *testing.T) {
	wrapped := chvWrapCommand("echo hello")

	mountIdx := strings.Index(wrapped, "mount -t virtiofs workspace /workspace")
	if mountIdx < 0 {
		t.Fatalf("chvWrapCommand output does not contain the pinned mount invocation (tag=workspace, mountpoint=/workspace); got:\n%s", wrapped)
	}
	cmdIdx := strings.Index(wrapped, "echo hello")
	if cmdIdx < 0 {
		t.Fatalf("chvWrapCommand output lost the user's command; got:\n%s", wrapped)
	}
	if !(mountIdx < cmdIdx) {
		t.Fatalf("chvWrapCommand mounts AFTER the user's command (mount at %d, cmd at %d) — the command could run against an unmounted /workspace; got:\n%s", mountIdx, cmdIdx, wrapped)
	}
}

// TestChvWrapCommandNeverSyncs pins the deliberate asymmetry with Firecracker's
// wrapCommand (which DOES sync): on this arm the host filesystem is the durability
// authority (spec §4.3), so a guest-side sync would be cargo-culted from the other
// arm, not a fix for anything. A future edit that "fixes" this by copying
// Firecracker's sync must fail this test, not slip through as a harmless-looking
// consistency improvement.
func TestChvWrapCommandNeverSyncs(t *testing.T) {
	wrapped := chvWrapCommand("echo hello")
	if strings.Contains(wrapped, "sync") {
		t.Fatalf("chvWrapCommand contains \"sync\" — this arm's Run must never sync (spec §4.3: the host filesystem is the durability authority, not the guest page cache); got:\n%s", wrapped)
	}
}

// TestChvWrapCommandPreservesExitCode asserts the same invariant Firecracker's
// wrapCommand documents for itself ("(exit $__fc_rc) preserves the command's own
// exit status"): this wrapper must not let the mount step, or its own bookkeeping,
// change what the user's command reports.
func TestChvWrapCommandPreservesExitCode(t *testing.T) {
	wrapped := chvWrapCommand("false")
	if !strings.Contains(wrapped, "$?") {
		t.Fatalf("chvWrapCommand does not appear to capture the command's own exit code; got:\n%s", wrapped)
	}
	if !strings.Contains(wrapped, "(exit $__chv_rc)") {
		t.Fatalf("chvWrapCommand does not re-exit with the captured code; got:\n%s", wrapped)
	}
}

// TestChvWrapCommandUnmountsStaleWorkspaceFirst is the idempotency decision round 8
// asked for explicitly: unlike Firecracker's Resume (`mountpoint -q /workspace ||
// mount ...`, which SKIPS mounting if already mounted), this arm cannot trust an
// already-mounted /workspace, because it is backed by a per-VM virtiofsd whose
// socket rewriteSnapshotConfig redirects on every restore — a mount that "looks"
// already there could be a stale session pointed at a virtiofsd that no longer
// exists. So this must unmount first and always remount fresh, never short-circuit
// on mountpoint -q succeeding.
func TestChvWrapCommandUnmountsStaleWorkspaceFirst(t *testing.T) {
	wrapped := chvWrapCommand("echo hello")
	if strings.Contains(wrapped, "mountpoint -q /workspace || mount") {
		t.Fatalf("chvWrapCommand uses Firecracker's short-circuit idempotency pattern — that is unsafe here (a stale virtio-fs session must not be trusted); got:\n%s", wrapped)
	}
	if !strings.Contains(wrapped, "umount /workspace") {
		t.Fatalf("chvWrapCommand does not unmount a possibly-stale /workspace before remounting; got:\n%s", wrapped)
	}
	umountIdx := strings.Index(wrapped, "umount /workspace")
	mountIdx := strings.Index(wrapped, "mount -t virtiofs workspace /workspace")
	if !(umountIdx >= 0 && mountIdx >= 0 && umountIdx < mountIdx) {
		t.Fatalf("chvWrapCommand does not unmount BEFORE remounting; got:\n%s", wrapped)
	}
}

// TestChvWrapCommandMountFailureBlocksTheCommand asserts the diagnosability
// requirement round 8 called out directly: "if the mount fails, the command must
// not run." The wrapper cannot exercise a real mount here (no KVM), so this checks
// the shell control flow instead: the mount-failure branch must exit before ever
// reaching the block that runs cmd.
func TestChvWrapCommandMountFailureBlocksTheCommand(t *testing.T) {
	wrapped := chvWrapCommand("echo should-not-run")
	failIdx := strings.Index(wrapped, "exit 97")
	if failIdx < 0 {
		t.Fatalf("chvWrapCommand's mount-failure branch does not exit before the command; got:\n%s", wrapped)
	}
	cmdIdx := strings.Index(wrapped, "echo should-not-run")
	if !(failIdx < cmdIdx) {
		t.Fatalf("chvWrapCommand's mount-failure exit is not before the command block; got:\n%s", wrapped)
	}
	if !strings.Contains(wrapped, chvMountFailMarker) {
		t.Fatalf("chvWrapCommand's mount-failure branch does not emit chvMountFailMarker; got:\n%s", wrapped)
	}
	// The marker line itself must name both the tag and the mount point — the exact
	// diagnosability ask: "the error must say the mount failed and name the tag and
	// mount point... otherwise it presents as a lost write."
	if !strings.Contains(wrapped, "tag=workspace") || !strings.Contains(wrapped, "mountpoint=/workspace") {
		t.Fatalf("chvWrapCommand's mount-failure marker does not name both the tag and the mount point; got:\n%s", wrapped)
	}
}

// TestChvMountFailSinkInterceptsTheMarker is the other half of the diagnosability
// fix: chvMountFailSink is what turns the marker chvWrapCommand emits into
// Run's returned error, rather than letting it flow through as if it were the
// user's own command output.
func TestChvMountFailSinkInterceptsTheMarker(t *testing.T) {
	inner := &fakeSink{}
	s := &chvMountFailSink{out: inner}

	s.Stdout([]byte("normal stdout\n"))
	s.Stderr([]byte(chvMountFailMarker + ": tag=workspace mountpoint=/workspace: mount: wrong fs type\n"))

	if !s.failed {
		t.Fatal("chvMountFailSink did not detect the marker")
	}
	if !bytes.Contains(s.detail, []byte("wrong fs type")) {
		t.Fatalf("chvMountFailSink.detail = %q, want it to contain the underlying mount error", s.detail)
	}
	if bytes.Contains(inner.stderr, []byte(chvMountFailMarker)) {
		t.Fatalf("chvMountFailSink forwarded the marker to the real Sink; inner.stderr = %q", inner.stderr)
	}
	if string(inner.stdout) != "normal stdout\n" {
		t.Fatalf("chvMountFailSink altered stdout pass-through; inner.stdout = %q", inner.stdout)
	}
}

// TestChvMountFailSinkPassesThroughOrdinaryOutput guards the "every other byte
// passes straight through" half of chvMountFailSink's contract: a successful run's
// real stderr (the user's own command output) must reach the caller unmodified.
func TestChvMountFailSinkPassesThroughOrdinaryOutput(t *testing.T) {
	inner := &fakeSink{}
	s := &chvMountFailSink{out: inner}

	s.Stdout([]byte("out\n"))
	s.Stderr([]byte("err\n"))

	if s.failed {
		t.Fatal("chvMountFailSink.failed = true for ordinary output containing no marker")
	}
	if string(inner.stdout) != "out\n" || string(inner.stderr) != "err\n" {
		t.Fatalf("chvMountFailSink did not pass ordinary output through unchanged: stdout=%q stderr=%q", inner.stdout, inner.stderr)
	}
}

// fakeSink is a minimal Sink that records what it was given, used by the
// chvMountFailSink tests above to assert on pass-through behavior directly (unlike
// discardingSink, which throws everything away and so cannot be inspected).
type fakeSink struct {
	stdout []byte
	stderr []byte
}

func (f *fakeSink) Stdout(b []byte) { f.stdout = append(f.stdout, b...) }
func (f *fakeSink) Stderr(b []byte) { f.stderr = append(f.stderr, b...) }

func TestChvScopeCgroupDir(t *testing.T) {
	if got := chvScopeCgroupDir("", "vm-7"); got != "" {
		t.Fatalf("chvScopeCgroupDir with no parent = %q, want empty", got)
	}
	for _, parent := range []string{DefaultParentCgroup, "custom.slice", "/" + DefaultParentCgroup + "/"} {
		dir := chvScopeCgroupDir(parent, "vm-7")
		if filepath.Dir(dir) != ParentCgroupPath(parent) {
			t.Errorf("parent %q: dir %q is not a child of %q", parent, dir, ParentCgroupPath(parent))
		}
		// The orphan sweep must recognise the directory the reader looks in.
		if base := filepath.Base(dir); !isPoolVMCgroupDirName(base) {
			t.Errorf("parent %q: the sweep does not recognise %q", parent, base)
		}
	}
	if got, want := chvScopeCgroupDir(DefaultParentCgroup, "vm-7"),
		"/sys/fs/cgroup/microvm.slice/microvm-vms.slice/vm-vm-7.scope"; got != want {
		t.Fatalf("chvScopeCgroupDir = %q, want %q", got, want)
	}
}
