package vmpool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// This file is the Cloud Hypervisor arm of Launcher (spec §3.5, §4.3, §6), the
// second VMM behind the same seam launcher_firecracker.go implements. It is
// modelled on that file deliberately — same process-lifetime discipline (Restore
// uses exec.Command, not exec.CommandContext, and hands the *exec.Cmd to the
// returned VM so Destroy, not ctx cancellation, ends its life), same
// errors.Join-based cleanup-on-every-failure-path convention, same idempotent
// Destroy — because this is a second arm, not a second style.
//
// THE ONE STRUCTURAL DIFFERENCE FROM FIRECRACKER: virtio-fs. The workspace here is
// not a guest-owned ext4 block device but a HOST directory arbitrated by virtiofsd,
// so (a) there are TWO host processes per standby, not one (cloud-hypervisor and
// its own virtiofsd — spec §7.3's "Σ PSS across VMM + virtiofsd"), and (b) the host
// filesystem, not a device mount, is the concurrency authority: SerializesExecsPerRun
// is false, D>1 standbys are safe, and Run mounts (fresh, every Exec, in its own
// command wrapper — round 8) but never syncs (see Run's comment). The no-sync half
// of that asymmetry with Task 15 is the trade spec §4.3 prices, not an omission; the
// mount half is not optional — round 7's gates found writes vanishing between Execs
// because nothing mounted the device virtio-fs merely attaches (task-16 report,
// round 8).
//
// CONFINEMENT GAP THIS FILE DOES NOT CLOSE (named per hardware-corrections C5):
// the cloud-hypervisor process itself runs UNCHROOTED on this arm. Firecracker gets
// jailer's chroot; Cloud Hypervisor has no jailer equivalent, and
// `systemd-run --scope` (the tutorial's own §8 proposal) reproduces jailer's cgroup
// behaviour but bundles no chroot, no --uid/--gid, nothing like jailer's
// hardlink-into-the-jail convention. virtiofsd itself DOES have a chroot/namespace
// mechanism (--sandbox=chroot|namespace, used below) so the narrower true gap is
// just the VMM process. Spec §5.3 expects an equivalent for it; Task 17 owns
// supplying the per-arm confinement/cgroup mechanism split, not this task. This is
// verified and known, not a guess: it was confirmed against a real cloud-hypervisor
// v53.0 restore on the rig rather than inferred from documentation.
//
// TASK 17'S DISPOSITION OF C5 (D3/D4, hardware-corrections): D3 — the cgroup half —
// IS closed below: chvSystemdRunScopeArgv wraps the cloud-hypervisor exec in
// `systemd-run --scope --slice=<the same slice Firecracker's jailer --parent-cgroup
// targets> -p MemoryMax=<vmpool.PerVMBytes(cfg)>`, giving this arm the same per-VM
// cgroup and memory.max bound jailer gives Firecracker's, from the same
// single-source-of-truth function (config.go's PerVMBytes) so the two arms cannot
// drift apart (spec §5.3). `--scope` was chosen specifically because it execs the
// target IN PLACE of the systemd-run client process rather than forking a detached
// unit (confirmed against systemd-run(1): "the invoked process is run as part of
// the scope unit... rather than as a child process of systemd-run"), so
// vmmCmd.Process.Pid, fcKillProcessGroup(pid), and vmmCmd.Wait() below all keep
// working unmodified — the single most safety-critical property this whole file
// has (Destroy must always be able to kill and reap what Restore started) is
// intended to be preserved exactly, on the strength of that documented
// exec-in-place behaviour. Round 12 (task-16 report) went looking for ground
// truth beyond the man page and could not get it: a captured hang showed
// cloud-hypervisor and virtiofsd both alive under `systemd-run --scope`, which
// is CONSISTENT with this claim but is not PROOF of it — the same observation is
// equally consistent with systemd-run remaining a distinct, still-alive parent
// that relocated the child into the scope's cgroup by some other means (e.g.
// clone()+cgroup-migrate, then blocking as a supervisor) rather than execve(2)
// in place. This file still has no host with systemd + KVM to tell the two
// apart, so this claim remains unverified end to end, not merely "unverified" as
// a formality. The round 12 fix (chvLogPath below) was deliberately designed to
// NOT depend on it being true: cloud-hypervisor is told its own --log-file path
// directly in its own argv, so its own words land in a file CH itself opens and
// writes, regardless of which process Go's exec.Cmd directly spawned or whether
// that process's stdout/stderr fds are the ones CH ends up inheriting.
//
// D4 — the chroot/filesystem-isolation half — is DELIBERATELY NOT closed here,
// and this is a reasoned finding, not a silent gap. The one mechanism that could
// close it without hand-rolled Go-level mount-namespace code is switching from
// `systemd-run --scope` to a transient systemd *service* (drop --scope), because
// only a full service unit's execution context grants access to systemd's
// filesystem-sandboxing properties (RootDirectory=, ProtectSystem=strict,
// BindPaths=/BindReadOnlyPaths=, DeviceAllow=/dev/kvm rw with PrivateDevices=yes,
// NoNewPrivileges=yes) — a --scope unit only relocates an already-running process
// into a cgroup and applies none of those. But a transient service forks
// asynchronously and is reaped by the systemd manager, not by this process, so
// keeping our foreground exec.Cmd handle synchronized with it would require one of
// systemd-run's --pipe/--wait/--collect flags, whose exact interaction with
// signal delivery and process-group membership this task has no real Linux host
// with systemd + KVM to verify. Getting that interaction wrong would silently
// break exactly the property D3 above was careful to preserve: sending SIGKILL to
// vmmCmd's own pid would kill the systemd-run client but NOT the systemd-managed
// service process tree it detached from, so Destroy would report success having
// killed nothing — reintroducing, for this arm, the precise "worker crash leaks
// VMs" failure spec §6 names as the #1 practical failure this whole task exists to
// prevent, except now on ordinary Destroy rather than only on a crash. Shipping
// that unverified is a worse outcome than shipping the already-disclosed gap: a
// known, named absence versus a confinement mechanism that looks correct in argv
// construction and quietly defeats cleanup in production. Closing D4 properly is
// left as a follow-up that needs hardware verification, not a code change made
// blind.
const (
	// defaultCHVVsockPort mirrors launcher_firecracker.go's defaultFCVsockPort: the
	// guest agent's own default ("vsock:1024"), duplicated rather than imported for
	// the same binary-to-package-dependency reason given there.
	defaultCHVVsockPort uint32 = 1024

	// chvSnapshotConfigFile, chvSnapshotMemoryRanges, chvSnapshotStateFile are Cloud
	// Hypervisor's own three-file snapshot directory layout — config.json,
	// memory-ranges, state.json — structurally different from Firecracker's
	// vmstate+memfile pair (snapshot.go's fileVMState/fileMemory), and NOT added as
	// package-level constants there because they are CH-specific, not shared shape.
	//
	// THESE ARE THE WRITE SIDE ONLY: the names Restore's staging step writes INTO
	// runDir, because that is what CH's own vm.restore requires inside the
	// directory it restores from. They are NOT the names the golden SnapshotDir
	// ships its files under — see chvGoldenVMState/chvGoldenMemFile/
	// chvGoldenConfigFile immediately below for the READ side, and do not collapse
	// the two blocks: config.json appears on the write side here but as
	// ch-config.json on the golden side, while memory-ranges/state.json here read
	// from golden files named memfile/vmstate — no name is shared between the two
	// sides, which is exactly what makes merging them back into one constant set
	// silently wrong.
	chvSnapshotConfigFile   = "config.json"
	chvSnapshotMemoryRanges = "memory-ranges"
	chvSnapshotStateFile    = "state.json"

	// chvGoldenVMState, chvGoldenMemFile, chvGoldenConfigFile are the names the
	// GOLDEN artifact (SnapshotDir) ships CH's snapshot files under. They differ
	// from chvSnapshot* above on purpose: deploy/microvm/build-snapshot.sh's
	// lock_down renames CH's native three-file output (config.json, memory-ranges,
	// state.json) into vmstate/memfile (the SAME pair Firecracker's snapshot uses)
	// plus ch-config.json, "so both VMMs feed write_manifest identically" (that
	// script's own comment) — one manifest schema, one hash set, one verify path
	// covers both arms. Restore's staging step is where that gets translated back:
	// it reads these golden names and writes the chvSnapshot* native names into
	// runDir, which is the one place CH's own native-name requirement actually has
	// to be satisfied.
	chvGoldenVMState    = "vmstate"
	chvGoldenMemFile    = "memfile"
	chvGoldenConfigFile = "ch-config.json"

	// chvGuestConsoleLog is the per-VM file this launcher points the GUEST's own
	// serial console at (config.json's console.file — see rewriteSnapshotConfig's
	// doc comment for the full field-by-field audit). This is the GUEST's console,
	// a wholly different thing from either of Restore's two HOST-side VMM-output
	// files (round 12's "vmm-stdio.log" and "cloud-hypervisor.log" — see the
	// package-level D3 comment's "TWO SEPARATE OUTPUT FILES" section) — three
	// distinct files, never conflated.
	//
	// Fix round 13: before this round, config.json's console.file was left exactly
	// as the golden snapshot recorded it — the jail-relative literal
	// "/console.log" build-snapshot.sh's CH arm passed via --console
	// file=/console.log — so every single restore was silently creating/
	// truncating a file at the HOST's real filesystem root, unchrooted. The
	// coordinator's captured CH log confirmed this is live on every restore (CH's
	// own "Booting VM from config" dump: `console: { file: Some("/console.log"),
	// mode: File }`), though — per that same log and per vmm/src/lib.rs's
	// pre_create_console_devices, cited in rewriteSnapshotConfig's doc comment —
	// File::create succeeds against a nonexistent "/console.log", so this was
	// never the failure that hung Restore; it was flagged in round 7 as a real
	// but non-blocking latent defect and is fixed now, in the same function,
	// because it is cheap to fix while already there and it stops the guest
	// console being written somewhere nobody looks.
	chvGuestConsoleLog = "guest-console.log"
)

// CHVOptions configures the Cloud Hypervisor launcher.
type CHVOptions struct {
	SnapshotDir  string // golden snapshot dir: vmstate, memfile, ch-config.json (see build-snapshot.sh's lock_down)
	CHVBin       string
	ChRemoteBin  string
	VirtiofsdBin string
	RunDir       string // per-VM sockets/config live under RunDir/<id>/

	// VirtiofsdUID/VirtiofsdGID are the unprivileged user virtiofsd drops to via
	// SysProcAttr.Credential before exec. Spec §3.5: with virtio-fs, guest path
	// resolution happens in virtiofsd on the HOST, so it is the confinement boundary
	// for the whole design — a root virtiofsd compromise would be host root and
	// would render the microVM boundary decorative. Refusing UID/GID 0 at
	// construction (validate, below) is the one place this can be enforced once and
	// for all rather than left to a deployment note nobody reads.
	VirtiofsdUID, VirtiofsdGID int

	// ParentCgroup mirrors FirecrackerOptions.ParentCgroup's doc comment exactly:
	// must be configured consistently with Task 17's systemd slice, or left empty
	// to defer to a default this launcher does not guess. When set, it names a
	// cgroupfs path (e.g. "/sys/fs/cgroup/microvm-vms.slice") — chvCgroupSliceName
	// derives the bare slice name systemd-run --slice wants from it, so callers
	// configure this launcher and the Firecracker one with the identical value.
	ParentCgroup string

	// CgroupMemoryMaxBytes mirrors FirecrackerOptions.CgroupMemoryMaxBytes exactly
	// (see that field's doc comment for the full D1 argument): the per-VM cgroup
	// memory.max this arm's systemd-run --scope is told to set via
	// `-p MemoryMax=`, MUST equal vmpool.PerVMBytes(cfg) — the same figure
	// admission control charges per VM — set by the caller, never a fresh
	// constant. Only meaningful, and only applied, when ParentCgroup is also set.
	CgroupMemoryMaxBytes int64

	// SystemdRunBin is the systemd-run binary used to create this VM's per-VM
	// cgroup scope (D3, hardware-corrections). Defaults to "systemd-run" (PATH
	// lookup) when empty; overridable for tests the same way CHVBin/ChRemoteBin/
	// VirtiofsdBin are.
	SystemdRunBin string

	// VsockPort is the guest agent's listen port. Defaults to 1024 when zero.
	VsockPort uint32
}

func (o *CHVOptions) setDefaults() {
	if o.VsockPort == 0 {
		o.VsockPort = defaultCHVVsockPort
	}
	if o.SystemdRunBin == "" {
		o.SystemdRunBin = "systemd-run"
	}
}

func (o CHVOptions) validate() error {
	switch {
	case o.SnapshotDir == "":
		return errors.New("cloud-hypervisor: SnapshotDir is required")
	case o.CHVBin == "":
		return errors.New("cloud-hypervisor: CHVBin is required")
	case o.ChRemoteBin == "":
		return errors.New("cloud-hypervisor: ChRemoteBin is required")
	case o.VirtiofsdBin == "":
		return errors.New("cloud-hypervisor: VirtiofsdBin is required")
	case o.RunDir == "":
		return errors.New("cloud-hypervisor: RunDir is required")
	case o.VirtiofsdUID == 0 || o.VirtiofsdGID == 0:
		// Spec §3.5's argument, verbatim in the error so a caller sees WHY, not just
		// THAT: virtiofsd resolves guest paths on the host, so it is the confinement
		// boundary for the whole design; a root virtiofsd compromise is host root and
		// makes the microVM boundary decorative.
		return errors.New("cloud-hypervisor: VirtiofsdUID/VirtiofsdGID must not be 0: " +
			"virtiofsd resolves guest paths on the host and is spec §3.5's confinement " +
			"boundary — running it as root would make that boundary decorative")
	case o.ParentCgroup != "" && o.CgroupMemoryMaxBytes <= 0:
		// D1's mirror for this arm: a ParentCgroup with no memory bound would leave
		// systemd-run --scope with nothing to set via -p MemoryMax=, which is this
		// arm's version of jailer moving a process into the slice without ever
		// creating a bounded per-VM cgroup. Fail loudly at construction, matching
		// launcher_firecracker.go's identical check.
		return errors.New("cloud-hypervisor: ParentCgroup is set but CgroupMemoryMaxBytes is <= 0 " +
			"— systemd-run --scope would create a per-VM cgroup with no memory.max " +
			"(spec §6 mitigation #3 would be unimplemented); set it from vmpool.PerVMBytes(cfg)")
	}
	return nil
}

// chvLauncher is the Cloud Hypervisor arm of Launcher.
type chvLauncher struct {
	opts CHVOptions
}

// NewCloudHypervisorLauncher validates opts, applies defaults, and returns a
// Launcher. Like NewFirecrackerLauncher, it touches nothing on disk and spawns
// nothing — that is all deferred to Restore, off the hot path (spec §4.3).
func NewCloudHypervisorLauncher(opts CHVOptions) (Launcher, error) {
	opts.setDefaults()
	if err := opts.validate(); err != nil {
		return nil, err
	}
	return &chvLauncher{opts: opts}, nil
}

func (l *chvLauncher) Kind() VMMKind { return CloudHypervisor }

// checkDeviceSharing implements deviceRequirer. Restore hardlinks (via
// chvStageSnapshotFiles's os.Link) the golden vmstate/memory-ranges files from
// l.opts.SnapshotDir into l.opts.RunDir, so those two must share one filesystem
// device or every Restore fails with EXDEV. Unlike Firecracker's jail, this
// arm's per-run workspace is never hardlinked anywhere: virtiofsd shares
// cfg.WorkspaceRoot with the guest directly over virtio-fs, so cfg.WorkspaceRoot
// is deliberately absent from this check — including it would over-constrain a
// real Cloud Hypervisor deployment for a hardlink that arm never performs.
func (l *chvLauncher) checkDeviceSharing(cfg Config) error {
	return checkPathsShareDevice(
		"Restore hardlinks the golden snapshot's vmstate and memory-ranges files "+
			"into the run directory, and hardlink(2) cannot cross devices",
		namedPath{"CHVOptions.SnapshotDir", l.opts.SnapshotDir},
		namedPath{"CHVOptions.RunDir", l.opts.RunDir},
	)
}

// SerializesExecsPerRun is false: virtio-fs means the HOST filesystem, not a
// guest-owned block device, arbitrates concurrent access to the workspace. This is
// spec §4.3's decisive row and the whole reason the VMM is a seam rather than a
// build choice — see TestCloudHypervisorSupportsTwoStandbysForOneRun, "the row
// that decides the arm".
func (l *chvLauncher) SerializesExecsPerRun() bool { return false }

// virtiofsdArgv builds virtiofsd's argv as a pure function so it is testable
// without spawning anything (TestVirtiofsdArgvCarriesItsSandbox).
//
//   - --sandbox=namespace, NEVER --sandbox=none: spec §6's malicious-symlink row
//     says virtiofsd's sandboxing "must be configured and verified, never assumed".
//     hardware-corrections C2: every virtiofsd in the reference tutorial ran under
//     sudo, and the binary's own --help flags unprivileged --sandbox=namespace as
//     documented but untested — kept anyway, unweakened, because the alternative
//     (--sandbox=none) is the one thing this design cannot tolerate.
//
//   - --cache=never, NOT --cache=auto. hardware-corrections C1: --cache=auto
//     disconnected the virtio-fs session immediately on the reference host;
//     --cache=never "stayed up through every subsequent test", and CH's own
//     quickstart already uses it. The tutorial explicitly did not root-cause the
//     --cache=auto disconnect ("plausibly a feature-negotiation mismatch") — this
//     comment does not invent one either; a confident wrong explanation would be
//     worse than none.
//
//   - NO --inode-file-handles=mandatory, even though the brief asked for it. Round-5
//     hardware probing (three runs, one variable at a time) found it INCOMPATIBLE with
//     the non-root requirement immediately above: opening a file handle for the shared
//     directory's root node requires CAP_DAC_READ_SEARCH, which a process that has
//     dropped to VirtiofsdUID/GID (an unprivileged uid, e.g. 65534) does not have —
//     confirmed by virtiofsd's own README ("and CAP_DAC_READ_SEARCH if
//     --inode-file-handles is used" / "virtiofsd can't use file handles ... requires
//     CAP_DAC_READ_SEARCH"). At uid 65534 with --inode-file-handles=mandatory,
//     virtiofsd logs "Failed to open file handle for the root node: Operation not
//     permitted (os error 1)", refuses to start ("Refusing to use (mandatory) file
//     handles, as they do not appear safe to use"), and exits — which is why Restore's
//     "virtiofsd socket never appeared" error was the shape this failed in on the rig.
//     At uid 65534 WITHOUT the flag, or at root WITH it, virtiofsd starts fine: the
//     flag and the unprivileged uid are what conflict, not --sandbox=namespace (C2,
//     confirmed separately and unchanged) and not the directory traversal fix from
//     Task 18 (also confirmed separately).
//
//     Spec §3.5 decides which requirement yields, and it is not close: with virtio-fs,
//     guest path resolution happens in virtiofsd ON THE HOST, so virtiofsd IS the
//     confinement boundary for the whole design — a root virtiofsd compromise is host
//     root and would render the microVM boundary decorative. That is a boundary
//     collapse. What mandatory file handles buy is narrower: they let virtiofsd
//     reference inodes by handle rather than by path, closing certain rename/symlink
//     TOCTOU race classes inside the shared directory. Losing them is a real but
//     bounded reduction in hardening against a guest racing paths in its own
//     workspace — trading that for avoiding a boundary collapse is the right
//     direction. This is a deliberate, evidenced downgrade, not an oversight: if you
//     are reading --sandbox=namespace here with no file-handle flag and wondering
//     whether the hardening was simply forgotten, it was not — see above.
//
//     Chose --inode-file-handles=prefer, explicit rather than omitted, over virtiofsd's
//     own bare "never". virtiofsd's README documents three values (never, prefer,
//     mandatory) and states prefer as its own default — "attempt to generate file
//     handles, but fall back to O_PATH file descriptors where ... CAP_DAC_READ_SEARCH
//     is not available" — which matches the coordinator's observed degrade-and-continue
//     log line ("File handles do not appear safe to use, disabling file handles
//     altogether") when the flag is left off entirely. Passing it explicitly, rather
//     than leaning on virtiofsd's unstated default, keeps the actual policy visible in
//     this argv rather than one version bump away from silently changing; "prefer"
//     rather than "never" costs nothing at VirtiofsdUID/GID and still gets file
//     handles for free on any deployment that ever runs this unprivileged uid with
//     CAP_DAC_READ_SEARCH available via a capability grant instead of root.
func virtiofsdArgv(opts CHVOptions, sock, dir string) []string {
	return []string{
		"--socket-path=" + sock,
		"--shared-dir=" + dir,
		"--sandbox=namespace",
		"--cache=never",
		"--inode-file-handles=prefer",
	}
}

// chvCgroupSliceName derives the bare slice unit name systemd-run --slice wants
// (e.g. "microvm-vms.slice") from ParentCgroup's cgroupfs path (e.g.
// "/sys/fs/cgroup/microvm-vms.slice") — the same value FirecrackerOptions.ParentCgroup
// takes, so a caller configures both arms identically and this is the one place that
// translates it into what systemd-run itself expects on its command line.
func chvCgroupSliceName(parentCgroup string) string {
	return filepath.Base(parentCgroup)
}

// chvSystemdRunScopeArgv returns the systemd-run argv PREFIX (everything before the
// real cloud-hypervisor binary and its own args) that creates and bounds this VM's
// per-VM cgroup (D3, hardware-corrections): --scope so the target execs in place of
// the systemd-run client rather than forking a detached unit (this file's
// package-level comment explains why that property is load-bearing for Destroy's
// kill-and-reap contract), --unit so the transient scope has a stable,
// human-diagnosable name, --slice so it lands under the SAME parent slice
// Firecracker's jailer --parent-cgroup targets (spec §5.3), and
// -p MemoryMax=<bytes> — the value that must equal vmpool.PerVMBytes(cfg), never a
// second constant (D1's argument, mirrored here). Split out of Restore's argv
// construction so a test can assert the memory bound agrees with PerVMBytes(cfg)
// without spawning systemd-run.
//
// The arms are NOT symmetric about that bound any more, so do not read one off the
// other: since #319 firecrackerCgroupArgs carries no bound at all — cgroupPool writes
// memory.max and jailer gets only --parent-cgroup — whereas this argv still carries
// its own, because systemd-run creates the scope's cgroup and nothing pools it.
//
// UNVERIFIED END TO END (see this file's package comment, D4 disposition): this task
// has no host with systemd + KVM to run this argv for real. What IS verified is the
// documented behaviour of --scope (systemd-run(1)) that motivated choosing it over a
// transient service.
func chvSystemdRunScopeArgv(opts CHVOptions, unitName string) []string {
	if opts.ParentCgroup == "" {
		return nil
	}
	args := []string{"--scope", "--unit=" + unitName, "--slice=" + chvCgroupSliceName(opts.ParentCgroup)}
	if opts.CgroupMemoryMaxBytes > 0 {
		args = append(args, "-p", fmt.Sprintf("MemoryMax=%d", opts.CgroupMemoryMaxBytes))
	}
	return args
}

// chvVMMArgv builds cloud-hypervisor's own argv (--api-socket, and — round 12,
// task-16 report — --log-file plus -v so CH's own words land in a file it opens
// and writes itself) and, when opts.ParentCgroup is set, wraps that argv behind
// chvSystemdRunScopeArgv's systemd-run --scope prefix, returning the binary to
// exec and its full argv. Split out of Restore's own construction, like
// virtiofsdArgv and chvSystemdRunScopeArgv above, specifically so a test can
// assert --log-file's path SURVIVES the systemd-run wrap (i.e. remains part of
// CH's own args, after l.opts.CHVBin in the wrapped argv, not swallowed by or
// confused with systemd-run's own flags) without spawning anything.
//
// unitName is only used when wrapping; callers pass "" when opts.ParentCgroup is
// empty (chvSystemdRunScopeArgv itself already no-ops on that, but threading it
// through here keeps this function's signature independent of that internal
// short-circuit).
func chvVMMArgv(opts CHVOptions, unitName, apiSock, logPath string) (bin string, argv []string) {
	argv = []string{"--api-socket", apiSock, "--log-file", logPath, "-v"}
	bin = opts.CHVBin
	if opts.ParentCgroup != "" {
		bin = opts.SystemdRunBin
		argv = append(chvSystemdRunScopeArgv(opts, unitName), append([]string{opts.CHVBin}, argv...)...)
	}
	return bin, argv
}

// chvChown is os.Chown, indirected so tests can verify Restore's ownership
// preparation without needing the real syscall's privilege (CAP_CHOWN, or
// already owning the target) that a non-root test runner has neither — see
// TestRestorePreparesVirtiofsdOwnership.
var chvChown = os.Chown

// chvChmod is os.Chmod, indirected for the same reason chvChown is: tests
// verify Restore's/chvPrepareVirtiofsdOwnership's chmod call site without
// depending on the real filesystem state a fake uid:gid chown leaves behind.
//
// Review finding (fix round 11): unlike chvChown, this needs no elevated
// privilege to succeed for real (chmod only requires owning the file, which
// the test process does, having just created runDir itself) — the seam
// exists purely so a test can observe the CALL, not because the real syscall
// is unusable in a test process the way root-only chown is.
var chvChmod = os.Chmod

// chvPrepareVirtiofsdOwnership chowns runDir and workspaceDir to uid:gid, and
// chmods runDir to ensure it is owner-writable, before virtiofsd is spawned.
//
// Review finding (fix round 1, item 1): Restore creates runDir via
// os.MkdirAll — owned by whatever this launcher process runs as — and then
// drops virtiofsd to VirtiofsdUID/VirtiofsdGID via SysProcAttr.Credential
// before exec (chvIsolateAndDropPrivileges). Without this chown, virtiofsd's
// own bind() of its socket inside runDir fails with EACCES the instant it
// starts, unless the launcher happens to already run as that uid — the
// unprivileged posture CHVOptions.VirtiofsdUID's doc comment and validate()
// exist to require was, before this fix, unable to actually start.
// workspaceDir needs the same treatment for the same reason one level up:
// virtiofsd must traverse into and serve it, so a directory it cannot enter
// fails identically to a socket it cannot create.
//
// This does NOT reach workspaceDir's ANCESTORS. Firecracker's UID/GID needs no
// analogous fix there because it only ever touches paths *inside* its own
// jail (a directory tree it created and chowns as it goes, exactly like
// runDir here); virtio-fs is different because virtiofsd serves req.WorkspaceDir
// directly rather than a copy hardlinked under a launcher-owned root, so its
// own ancestor chain is out of this launcher's control — it belongs to
// whatever created WorkspaceDir (the pool/orchestration layer), the same class
// of assumption this file already makes about RunDir's and SnapshotDir's own
// parents being reachable.
//
// Review finding (fix round 11): the chown above was, on its own, an
// INCOMPLETE guarantee for runDir specifically. Chown changes ownership only —
// it says nothing about the mode bits, which up to this fix rested entirely on
// the mode argument Restore's own os.MkdirAll(runDir, 0o700) call passed when
// it FIRST created runDir. That argument is a no-op the moment runDir already
// exists (MkdirAll never chmods a pre-existing directory), and nothing after
// creation ever independently re-asserted or verified it — unlike
// workspaceDir, which already had BOTH an active fix (this chown) AND an
// independent verification (chvCheckWorkspaceReachable, fix round 3) before
// this round. runDir had only the active half of that pattern. The hardware
// repro this fix round starts from — virtiofsd's "Error creating pid file
// '<socket>.pid': Permission denied" — is exactly what an owner-writable
// assumption silently failing looks like: virtiofsd needs to WRITE a new
// directory entry (the socket, and the .pid file it creates beside it) into
// runDir, not merely traverse it, so this chmod closes the same kind of gap
// for runDir's own mode that fix round 1 already closed for its ownership.
// chmod, deliberately, only ever targets runDir here, never workspaceDir:
// workspaceDir is the pool/orchestration layer's directory, not this
// launcher's own, and this file already treats it as off-limits for anything
// beyond chown (see the "does NOT reach workspaceDir's ANCESTORS" paragraph
// above) — actively rewriting its mode bits would be the same overreach one
// level down.
func chvPrepareVirtiofsdOwnership(runDir, workspaceDir string, uid, gid int) error {
	if err := chvChown(runDir, uid, gid); err != nil {
		return fmt.Errorf("chown run dir %s to %d:%d: %w", runDir, uid, gid, err)
	}
	if err := chvChmod(runDir, 0o700); err != nil {
		return fmt.Errorf("chmod run dir %s to 0700: %w", runDir, err)
	}
	if err := chvChown(workspaceDir, uid, gid); err != nil {
		return fmt.Errorf("chown workspace dir %s to %d:%d: %w", workspaceDir, uid, gid, err)
	}
	return nil
}

// chvPrepareOwnership is chvPrepareVirtiofsdOwnership, indirected so a test can
// observe the CALL SITE inside Restore — not just the helper in isolation.
//
// Review finding (fix round 2): the round-1 tests
// (TestRestorePreparesVirtiofsdOwnership and its failure-propagation
// sibling) called chvPrepareVirtiofsdOwnership directly and never exercised
// Restore at all. That leaves the integration point — whether Restore
// actually calls the helper, and with which uid/gid — uncovered: a mutation
// that changed Restore's call site to pass 0:0 (chown to root, undoing the
// whole fix) or removed the call entirely still passed every test, because
// nothing was watching that call site. See TestRestoreCallsPrepareOwnership.
var chvPrepareOwnership = chvPrepareVirtiofsdOwnership

// chvCheckWorkspaceReachable is checkPathTraversableBy (traversalcheck.go)
// through a seam, for the same reason chvPrepareOwnership is one: a test can
// then observe the CALL SITE inside Restore — that it runs, with which path
// and uid/gid, and that a failure here aborts Restore before virtiofsd is ever
// spawned — not just the underlying check in isolation. See
// TestRestoreChecksWorkspaceReachableBeforeVirtiofsd.
var chvCheckWorkspaceReachable = checkPathTraversableBy

// chvCheckSocketDirWritable is checkPathWritableBy (traversalcheck.go) through
// a seam, for the same reason chvCheckWorkspaceReachable is one: a test can
// observe the CALL SITE inside Restore rather than just the helper in
// isolation.
//
// Review finding (fix round 11): this is deliberately independent of, not a
// replacement for, the chvChmod call inside chvPrepareVirtiofsdOwnership.
// chmod is the ACTIVE fix (make runDir owner-writable); this is the PASSIVE
// verification that it actually took effect, mirroring exactly how
// workspaceDir already gets both an active chown (chvPrepareOwnership) and an
// independent check (chvCheckWorkspaceReachable) rather than trusting the
// active half alone. Without this, a chmod that silently failed to have the
// intended effect (e.g. a filesystem that clamps permissions, or a future
// regression that reorders/removes the chmod call) would still let Restore
// proceed to spawn virtiofsd, reproducing the exact diagnostically-opaque
// 20-30s Restore hang this fix round starts from — virtiofsd dying with EACCES
// before it ever binds its socket, cloud-hypervisor waiting on a backend that
// will never appear, until the pool's own timeout fires. This check turns
// that into an immediate, precise error naming runDir, its mode, and the
// uid/gid that cannot write to it, raised BEFORE fsCmd.Start() rather than
// discovered 20-30s later as a timeout with no causal thread back to this.
//
// Where chvCheckWorkspaceReachable checks req.WorkspaceDir's ANCESTORS for
// TRAVERSAL (execute only — see checkPathTraversableBy's own doc comment),
// this checks runDir ITSELF (the leaf virtiofsd's socket and .pid file are
// created in) for WRITE (write+execute — see checkPathWritableBy's own doc
// comment). The two checks cover disjoint paths and disjoint properties by
// design, not by oversight: WorkspaceDir's ancestors belong to the pool/
// orchestration layer and this launcher can only verify them, never fix them;
// runDir is this launcher's own directory, created by its own os.MkdirAll,
// so it is the one place this file both actively fixes AND independently
// verifies the same property.
var chvCheckSocketDirWritable = checkPathWritableBy

// rewriteSnapshotConfig returns a copy of the golden snapshot's config.json with
// its embedded vsock socket path, (if present) virtio-fs socket path, and every
// disk's path replaced by host-resolvable ones.
//
// WHY THIS EXISTS (a design decision this task made, not one the brief or
// hardware-corrections prescribe a mechanism for): the reference tutorial
// documents that config.json embeds the vsock socket path VERBATIM, and that
// restoring the SAME snapshot without removing the stale socket collides —
// "Cannot create virtio-vsock backend", "Error binding to the host-side Unix
// socket" (errno 98, address in use) — because "whichever process restores it
// recreates that path". The tutorial's own fix (rm -f the stale socket) only
// covers SEQUENTIAL restores where the first VM is already dead; it does not
// cover TWO LIVE standbys restored from the identical config.json at once, which
// is exactly what TestCloudHypervisorSupportsTwoStandbysForOneRun exercises.
// hardware-corrections C8 anticipates needing exactly this: "If that test
// nonetheless fails, the disk lock is not your cause; look at ... the vsock
// socket path, or the snapshot's own config.json." This function, plus Restore's
// per-VM directory below, is this task's answer to that hint.
//
// Fix round 7 EXTENDS this to disks[].path, for a DIFFERENT reason than vsock/fs:
// vsock and fs sockets vary PER VM (each standby needs its own, or they collide).
// disks[].path does not vary per VM at all — every standby is rewritten to the
// exact SAME absolute host path, filepath.Join(SnapshotDir, fileRootfs) — every
// standby shares the one golden rootfs file, unconditionally. The reason it still
// needs rewriting is different: build-snapshot.sh's CH arm builds the golden
// snapshot chrooted into a jail, so config.json's disks[].path is recorded
// JAIL-RELATIVE ("/rootfs") — meaningless once this launcher restores it
// unchrooted (a documented gap this file's package comment attributes to Task
// 17), where "/rootfs" resolves against the HOST's real root, and nothing lives
// there. ch-remote restore's own error on real hardware is exact about this:
// "Cannot open disk path","I/O error (path=/rootfs op=open)","No such file or
// directory (os error 2)".
//
// THIS IS NOT A REVERSAL of the earlier "disks is deliberately left untouched"
// decision — that decision was, and remains, about disks[].readonly, not
// disks[].path, and the two must not be conflated:
//   - readonly stays exactly as the golden snapshot's own config.json already has
//     it (readonly=on, baked in by build-snapshot.sh's own
//     `--disk "path=/rootfs,readonly=on"`). This launcher still never sets or
//     forces it. C4/C8 already confirmed readonly=on gives the rootfs a
//     SharedRead advisory lock, and SharedRead locks coexist — verified directly
//     on the rig (a writable open was refused with "Can't get Write lock ... as
//     there is already a SharedRead lock", while a readonly one was not), which
//     is what lets N standbys open the one golden rootfs concurrently. That is a
//     build-pipeline concern; this launcher's argv is still silent on it.
//   - path IS rewritten, because it is a RESTORER-side concern the golden
//     snapshot cannot itself resolve: it was recorded relative to a jail
//     directory structure ($jail as "/") that no longer exists once the snapshot
//     is copied out and restored somewhere else, unchrooted. Something on the
//     restore side has to translate it back to a real, absolute, host path —
//     exactly the same class of problem vsock.socket already had, and exactly why
//     this function is where the fix belongs. No staging or per-VM copy is
//     needed: every standby is handed the identical absolute path, on purpose.
//
// Audit of other config.json fields that might carry a similar jail-relative
// path — walking build-snapshot.sh's CH-arm jail invocation (--kernel /kernel,
// --disk path=/rootfs, --vsock socket=/vsock.sock, --console
// file=/console.log) against Cloud Hypervisor v53.0's own vmm/src/vm_config.rs
// and vmm/src/lib.rs. THIS SECTION WAS WRONG ONCE (round 7) AND HAS BEEN
// CORRECTED (round 13) — see the task-16 report's fix-round-13 section for the
// full story of how, and why the correction rests on the daemon's own log
// rather than on source reading a second time:
//
//   - payload.kernel ("/kernel"): round 7 concluded this was "safe (never
//     re-read on restore — snapshot.is_none() gate)", reasoning from
//     vmm/src/vm.rs's load_payload_async call site. THIS WAS WRONG. The
//     coordinator's captured CH log, mid-hang, showed CH logging "Booting VM
//     from config" — with payload.kernel: Some("/kernel") still present — while
//     servicing a VmRestore API call, i.e. the code path that reconstructs a
//     restored VM's config DOES carry this field forward and does act on it
//     though. It does not exist on the host, because this launcher deliberately
//     does not chroot (this file's package comment, hardware-corrections C5).
//     THE lesson (stated because it generalizes beyond this one field): source
//     reading told round 7 which code path SHOULD run; the daemon's own log
//     told round 13 which code path DID run. When those disagree, the log
//     wins. Now rewritten to the golden kernel's absolute host path,
//     filepath.Join(SnapshotDir, fileKernel) — exactly the same treatment as
//     disks[].path already got in round 7, for the identical reason: every
//     standby shares the one golden kernel file, unconditionally, so this is
//     not per-VM-unique the way vsock/fs sockets are.
//   - console.file ("/console.log"): round 7's read of this field's BLOCKING
//     behavior was correct (File::create succeeds against a nonexistent host
//     "/console.log", so this was never what hung Restore) and remains
//     correct — the coordinator's round-13 log confirms CH got well past this
//     point. Round 7 also correctly flagged it as "a real but separate
//     non-blocking latent defect (host-root pollution)" and left it unfixed on
//     purpose, as out of that round's scope. Round 13 fixes it now, while
//     already in this function for payload.kernel: rewritten into the per-VM
//     run directory (chvGuestConsoleLog) instead of the host's real root.
//   - vsock.socket, fs[].socket, disks[].path: already handled, above.
//
// THE SET IS NOW CLOSED, as of round 13, verified against the coordinator's
// OWN real config dump (not against source inference — the round-7 approach
// this round is explicitly correcting): every field in that dump that could
// possibly hold a host path has been enumerated and disposed of.
//   - memory, disks[].readonly/image_type, fs[].tag/num_queues/queue_size,
//     vsock.cid: not paths.
//   - rng.src ("/dev/urandom"): IS a host path, and is left untouched
//     deliberately, not by omission — unlike every path this function does
//     rewrite, "/dev/urandom" is not jail-relative and not per-VM: it resolves
//     to the same real host device inside or outside any chroot, so there is
//     nothing here for a restore-side rewrite to fix.
//   - serial: mode is "Off" in this build (--serial off), so no file field is
//     even present in config.json to rewrite.
//   - initramfs: None in this build; not present in config.json at all.
//   - No other VmConfig field (net, pmem, devices, vdpa, numa, etc.) is
//     configured by build-snapshot.sh's CH arm at all, so none of them appear
//     in the golden config.json to begin with.
//
// UNVERIFIED END TO END: this task has no KVM access, so this rewrite has been
// exercised only as a pure function against synthetic JSON (see
// launcher_chv_test.go), never against a real config.json or a real restore.
// Round 12's capture fix is what will tell the coordinator, from the daemon's
// own words, whether this round's two rewrites actually clear the hang.
func rewriteSnapshotConfig(src []byte, vsockPath, fsSocketPath, rootfsPath, kernelPath, consolePath string) ([]byte, error) {
	var doc map[string]any
	if err := json.Unmarshal(src, &doc); err != nil {
		return nil, fmt.Errorf("parse config.json: %w", err)
	}
	if vsock, ok := doc["vsock"].(map[string]any); ok {
		vsock["socket"] = vsockPath
	}
	if fsSocketPath != "" {
		if fsList, ok := doc["fs"].([]any); ok {
			for _, entry := range fsList {
				if fs, ok := entry.(map[string]any); ok {
					fs["socket"] = fsSocketPath
				}
			}
		}
	}
	// Fix round 7: every disk entry's path is rewritten to the same absolute
	// golden-rootfs path, unconditionally — unlike vsock/fs above, this is
	// deliberately NOT per-VM-unique. readonly is untouched: see this function's
	// doc comment for why that split is intentional, not an oversight.
	if diskList, ok := doc["disks"].([]any); ok {
		for _, entry := range diskList {
			if disk, ok := entry.(map[string]any); ok {
				disk["path"] = rootfsPath
			}
		}
	}
	// Fix round 13: payload.kernel, like disks[].path, is rewritten to the SAME
	// absolute golden path for every standby — the coordinator's captured CH log
	// proved this field IS carried forward and acted on during VmRestore,
	// contradicting round 7's source-reading-only conclusion that it was safe
	// left alone. See this function's doc comment for the full correction.
	if payload, ok := doc["payload"].(map[string]any); ok {
		payload["kernel"] = kernelPath
	}
	// Fix round 13: console.file is redirected into the per-VM run directory,
	// unlike disks[].path/payload.kernel above — this one legitimately IS
	// per-VM (each standby's guest console belongs in ITS OWN run dir, not
	// shared), the same per-VM-unique treatment vsock.socket/fs[].socket
	// already get, for the same reason: two standbys sharing one file here
	// would each silently truncate the other's guest console output.
	if console, ok := doc["console"].(map[string]any); ok {
		console["file"] = consolePath
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("marshal config.json: %w", err)
	}
	return out, nil
}

// chvStageSnapshotFiles stages one standby's snapshot files into runDir under
// CH's OWN required native names, translating from the golden artifact's unified
// names as it goes (see chvGoldenVMState/chvGoldenMemFile/chvGoldenConfigFile and
// chvSnapshotMemoryRanges/chvSnapshotStateFile/chvSnapshotConfigFile above for
// the full naming rationale). This translation exists because
// deploy/microvm/build-snapshot.sh's lock_down deliberately ships CH's snapshot
// under the SAME vmstate/memfile names Firecracker uses (plus ch-config.json)
// rather than CH's native config.json/memory-ranges/state.json — one manifest
// schema and hash set covers both arms — while CH's own vm.restore still requires
// its native names inside the directory it restores from. runDir is that
// directory, so this function is where the two requirements reconcile: it is a
// pure filesystem operation (hardlink + read/rewrite/write), no exec and no KVM,
// so it is unit-testable on its own — see
// TestRestoreStagesCHNativeNamesFromGoldenNames, added specifically because a
// mismatch here (reading CH-native names from a golden dir that never has them)
// shipped once already and no test caught it.
func chvStageSnapshotFiles(snapshotDir, runDir, vsockSock, fsSock string) error {
	for _, m := range []struct{ golden, native string }{
		{chvGoldenMemFile, chvSnapshotMemoryRanges},
		{chvGoldenVMState, chvSnapshotStateFile},
	} {
		src := filepath.Join(snapshotDir, m.golden)
		dst := filepath.Join(runDir, m.native)
		_ = os.Remove(dst) // best-effort: a stale link from an aborted prior attempt at this ID
		if err := os.Link(src, dst); err != nil {
			return fmt.Errorf("hardlink %s: %w", m.native, err)
		}
	}
	golden, err := os.ReadFile(filepath.Join(snapshotDir, chvGoldenConfigFile))
	if err != nil {
		return fmt.Errorf("read golden config.json: %w", err)
	}
	// Fix round 7: rootfsPath is the golden rootfs's own absolute path — every
	// standby's disks[].path is rewritten to this SAME value, not staged or
	// hardlinked per-VM (see rewriteSnapshotConfig's doc comment for why that is
	// safe and deliberate).
	rootfsPath := filepath.Join(snapshotDir, fileRootfs)
	// Fix round 13: kernelPath mirrors rootfsPath exactly -- one golden kernel
	// file, one absolute path, shared unrewritten by every standby.
	// consolePath, by contrast, is per-VM: it lives under THIS restore's own
	// runDir, not under the shared snapshotDir, so two standbys never fight
	// over the same guest-console file (see rewriteSnapshotConfig's doc
	// comment for the full contrast between the two).
	kernelPath := filepath.Join(snapshotDir, fileKernel)
	consolePath := filepath.Join(runDir, chvGuestConsoleLog)
	rewritten, err := rewriteSnapshotConfig(golden, vsockSock, fsSock, rootfsPath, kernelPath, consolePath)
	if err != nil {
		return fmt.Errorf("rewrite config.json: %w", err)
	}
	if err := os.WriteFile(filepath.Join(runDir, chvSnapshotConfigFile), rewritten, 0o600); err != nil {
		return fmt.Errorf("write per-VM config.json: %w", err)
	}
	return nil
}

// Restore brings up one standby from the golden snapshot and returns it PAUSED
// (CH's own restore does not resume — Resume, below, does). Every failure path
// cleans up whatever it already created and returns (nil, err), mirroring
// launcher_firecracker.go's Restore exactly: never a non-nil VM alongside a
// non-nil error.
func (l *chvLauncher) Restore(ctx context.Context, req RestoreRequest) (VM, error) {
	// Reused directly from the Firecracker arm: always nil on unix, and Cloud
	// Hypervisor/virtiofsd require Linux just as much as Firecracker/jailer do, so
	// this is the same clean-refusal-before-spawning-anything check, not a
	// Firecracker-specific one that happens to also work here.
	if err := fcPlatformSupported(); err != nil {
		return nil, fmt.Errorf("cloud-hypervisor: restore %s: %w", req.ID, err)
	}

	runDir := filepath.Join(l.opts.RunDir, req.ID)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return nil, fmt.Errorf("cloud-hypervisor: restore %s: create run dir: %w", req.ID, err)
	}

	var (
		vmmCmd    *exec.Cmd
		fsCmd     *exec.Cmd
		console   *os.File
		fsConsole *os.File
	)
	// cleanup mirrors launcher_firecracker.go's Restore cleanup closure: kill
	// whatever was already spawned (VMM first, then virtiofsd, per the brief and
	// per Destroy below), then remove the per-VM run directory. Every failure return
	// in this function goes through it, so a partially-started Restore never leaks a
	// process or socket the caller has no handle to destroy.
	cleanup := func() error {
		var errs []error
		if vmmCmd != nil && vmmCmd.Process != nil {
			pid := vmmCmd.Process.Pid
			if err := fcKillProcessGroup(pid); err != nil && !fcProcessNotFound(err) {
				errs = append(errs, fmt.Errorf("kill cloud-hypervisor -%d: %w", pid, err))
			}
			_ = vmmCmd.Wait()
		}
		if fsCmd != nil && fsCmd.Process != nil {
			pid := fsCmd.Process.Pid
			if err := fcKillProcessGroup(pid); err != nil && !fcProcessNotFound(err) {
				errs = append(errs, fmt.Errorf("kill virtiofsd -%d: %w", pid, err))
			}
			_ = fsCmd.Wait()
		}
		if console != nil {
			_ = console.Close()
		}
		if fsConsole != nil {
			_ = fsConsole.Close()
		}
		if err := os.RemoveAll(runDir); err != nil {
			errs = append(errs, fmt.Errorf("remove run dir %s: %w", runDir, err))
		}
		return errors.Join(errs...)
	}

	// Review finding (fix round 1, item 1): chown BOTH paths virtiofsd needs —
	// the run dir it will bind its own socket inside, and the workspace it must
	// traverse into and serve — to the uid/gid it is about to drop to. This must
	// happen after runDir exists (MkdirAll above) and before fsCmd.Start() below;
	// doing it any later leaves a window where virtiofsd's own bind()/traversal
	// hits EACCES instead of finding a directory it can already enter. See
	// chvPrepareVirtiofsdOwnership's doc comment for what this does and does not
	// cover (workspaceDir's ancestors are out of scope here).
	if err := chvPrepareOwnership(runDir, req.WorkspaceDir, l.opts.VirtiofsdUID, l.opts.VirtiofsdGID); err != nil {
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: %w", req.ID, err), cleanup())
	}

	// Review finding (fix round 3): chvPrepareOwnership, just above, correctly
	// chowns req.WorkspaceDir itself — but its own doc comment says plainly it
	// does not reach WorkspaceDir's ANCESTORS, which belong to whoever created
	// WorkspaceDir, not to this launcher. On the rig, one of those ancestors
	// was a root-owned 0700 directory (a hardlink-jail sibling dir the gates
	// harness created next to the golden snapshot — see
	// sameDeviceSiblingDir's fix round 3 doc comment in
	// launcher_firecracker_test.go), and it silently blocked virtiofsd's own
	// unprivileged (VirtiofsdUID/GID) traversal into the correctly-chowned
	// leaf beneath it. virtiofsd does not diagnose that itself: it reported
	// the leaf as though it "does not exist" — an EACCES on an ancestor, from
	// virtiofsd's side, looks identical to the leaf never having been created
	// at all — which sent the coordinator chasing a phantom missing directory
	// they could plainly see on disk.
	//
	// Check reachability explicitly, before virtiofsd is ever spawned, so a
	// real fault here surfaces as a precise ancestor + mode + uid error
	// instead of virtiofsd's own misleading one. This is a DIAGNOSTIC ONLY:
	// it must never chmod anything on the caller's behalf — a launcher
	// silently loosening permissions on a directory it did not create would
	// be worse than the error it replaces, and it is not this launcher's
	// directory to fix.
	if err := chvCheckWorkspaceReachable(req.WorkspaceDir, uint32(l.opts.VirtiofsdUID), uint32(l.opts.VirtiofsdGID)); err != nil {
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: workspace unreachable by virtiofsd: %w", req.ID, err), cleanup())
	}

	// Review finding (fix round 11): the coordinator's rig reproduced a
	// DIFFERENT failure than fix round 3's — not "workspace unreachable" but
	// virtiofsd's own "Error creating pid file '<socket>.pid': Permission
	// denied", surfacing only as a Restore hang until the pool's ~20s timeout,
	// because cloud-hypervisor has no way to know virtiofsd died before ever
	// binding its backend socket. chvPrepareOwnership above (via chvChmod, see
	// its own doc comment) now actively makes runDir owner-writable, but that
	// chmod's success is unverified from here on — exactly the asymmetry
	// runDir had relative to workspaceDir before this fix round (an active fix
	// with no independent check). Verify it actually took, for the same
	// "precise error now, not an opaque timeout later" reason
	// chvCheckWorkspaceReachable exists: this checks runDir itself (the leaf
	// virtiofsd's socket and .pid sidecar file are created in) for WRITE, not
	// req.WorkspaceDir's ancestors for traversal — see
	// chvCheckSocketDirWritable's own doc comment for why these are disjoint
	// checks over disjoint paths, not a duplicate of the check just above.
	if err := chvCheckSocketDirWritable(runDir, uint32(l.opts.VirtiofsdUID), uint32(l.opts.VirtiofsdGID)); err != nil {
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: virtiofsd socket directory not writable: %w", req.ID, err), cleanup())
	}

	// --- virtiofsd, privileges dropped before exec (never run as root: see
	// CHVOptions.VirtiofsdUID's doc comment and validate() above). Its own
	// stdout/stderr are captured to a file, not discarded (review finding, fix
	// round 1, item 2): with output discarded, the exact EACCES failure item 1
	// fixes would have surfaced as nothing but a bare socket timeout below —
	// which is precisely the "secure configuration looks broken for no visible
	// reason" trap hardware-corrections C2 warns against, the one that tempts a
	// reader into "fixing" it by running virtiofsd as root instead. ---
	fsSock := filepath.Join(runDir, "vfsd.sock")
	fsArgv := virtiofsdArgv(l.opts, fsSock, req.WorkspaceDir)
	fsCmd = exec.Command(l.opts.VirtiofsdBin, fsArgv...)
	var err error
	fsConsole, err = os.Create(filepath.Join(runDir, "virtiofsd.log"))
	if err != nil {
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: create virtiofsd console log: %w", req.ID, err), cleanup())
	}
	fsCmd.Stdout = fsConsole
	fsCmd.Stderr = fsConsole
	chvIsolateAndDropPrivileges(fsCmd, l.opts.VirtiofsdUID, l.opts.VirtiofsdGID)
	if err := fsCmd.Start(); err != nil {
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: start virtiofsd: %w", req.ID, err), cleanup())
	}
	if err := waitForUnixSocket(ctx, fsSock, 5*time.Second); err != nil {
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: virtiofsd socket never appeared: %s: %w", req.ID, chvReadConsole(fsConsole.Name()), err), cleanup())
	}

	// --- per-VM snapshot config: hardlink the two large golden files unchanged
	// (renaming golden -> CH-native as they land in runDir — see chvGolden* above
	// and chvStageSnapshotFiles's own doc comment for why this translation exists
	// at all), copy+rewrite config.json's embedded vsock/fs socket paths so two
	// standbys restored from the SAME golden snapshot never collide on either
	// socket path — see rewriteSnapshotConfig's doc comment for the full
	// justification and its "unverified end to end" caveat. ---
	vsockSock := filepath.Join(runDir, "vsock.sock")
	if err := chvStageSnapshotFiles(l.opts.SnapshotDir, runDir, vsockSock, fsSock); err != nil {
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: %w", req.ID, err), cleanup())
	}

	// --- cloud-hypervisor itself. UNCHROOTED on this arm — see this file's
	// package-level comment (hardware-corrections C5, and Task 17's D3/D4
	// disposition of it just below that): the per-VM CGROUP half of that gap IS
	// closed here, via chvSystemdRunScopeArgv, when l.opts.ParentCgroup is set; the
	// filesystem-confinement half is a documented, reasoned non-closure, not a
	// silent one.
	//
	// TWO SEPARATE OUTPUT FILES, on purpose (task-16 report, round 12), because they
	// can carry different things and neither may be trusted alone:
	//
	//   - vmmStdio ("vmm-stdio.log"): vmmCmd.Stdout/Stderr — the stdout/stderr of
	//     whatever process Go's exec.Cmd directly spawned. When l.opts.ParentCgroup
	//     is set that process is systemd-run, not cloud-hypervisor (see the D3
	//     comment above, now updated): systemd-run's own pre-exec announcement
	//     ("Running scope as unit: ...") lands here for certain; whether
	//     cloud-hypervisor's later writes ALSO land here depends on the still-
	//     unverified claim that --scope execs in place preserving inherited fds.
	//     This file was previously named "console.log", which round 12 renamed
	//     specifically so it stops reading as the same thing as the GUEST's own
	//     console (config.json's console.common.file — see this function's other
	//     doc comment on rewriteSnapshotConfig, a wholly separate, already-disclosed
	//     latent defect, not touched here).
	//
	//   - chvLogPath ("cloud-hypervisor.log"): passed to cloud-hypervisor itself via
	//     its own --log-file flag (confirmed against cloudhypervisor.org's CLI
	//     reference: "--log-file <log-file> Log file. Standard error is used if not
	//     specified"), plus -v for verbosity. Cloud-hypervisor opens and writes this
	//     file ITSELF, by its own path argument, independent of which process Go
	//     directly spawned and independent of whether that process's stdio fds are
	//     the ones CH inherits. This is what makes CH's own words legible in a
	//     failure regardless of how the still-unverified systemd-run --scope
	//     exec-in-place claim turns out — round 12 was explicitly about making the
	//     failure legible rather than guessing at the vhost-user disconnect that
	//     provoked it (task-16 report, round 12; that disconnect itself is NOT
	//     addressed by this change — no speculative fix for it was made).
	apiSock := filepath.Join(runDir, "api.sock")
	chvLogPath := filepath.Join(runDir, "cloud-hypervisor.log")
	console, err = os.Create(filepath.Join(runDir, "vmm-stdio.log"))
	if err != nil {
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: create vmm stdio log: %w", req.ID, err), cleanup())
	}
	// chvScopeUnitName, not a "vm-"+req.ID literal: systemd turns this unit name into a
	// "<unit>.scope" cgroup directory under --slice, and SweepOrphans' fail-closed
	// filter has to recognise that exact directory name. One function, so the launcher
	// and the sweep cannot drift apart (final review H1; cgroup.go's naming block).
	vmmBin, vmmArgv := chvVMMArgv(l.opts, chvScopeUnitName(req.ID), apiSock, chvLogPath)
	vmmCmd = exec.Command(vmmBin, vmmArgv...)
	vmmCmd.Stdout = console
	vmmCmd.Stderr = console
	chvIsolateAndDropPrivileges(vmmCmd, 0, 0) // Setpgid only: uid==0 is a no-op sentinel, see the helper's doc comment
	if err := vmmCmd.Start(); err != nil {
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: start cloud-hypervisor: %w", req.ID, err), cleanup())
	}
	if err := waitForUnixSocket(ctx, apiSock, 5*time.Second); err != nil {
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: API socket never appeared: vmm stdio: %s cloud-hypervisor log: %s: %w", req.ID, chvReadConsole(console.Name()), chvReadConsole(chvLogPath), err), cleanup())
	}

	// ch-remote restore <restore_config>, where restore_config is the single
	// positional comma-separated key=value string chvRestoreConfigArg builds — see
	// that function's doc comment for why this is a positional string and not
	// "--source-url" (a shape this file previously, incorrectly, assumed), and for
	// why resume=false is passed explicitly rather than left to ch-remote's
	// default. restore_config exposes only source_url, resume, memory_restore_mode,
	// prefault, and net_fds — no field-level override for vsock/fs socket paths the
	// way Firecracker's LoadSnapshot has vsock_override (fcapi.go) — which is
	// exactly why the per-VM directory above exists: there is no other restore-time
	// knob to redirect those paths.
	restoreOut, err := exec.CommandContext(ctx, l.opts.ChRemoteBin,
		"--api-socket", apiSock, "restore", chvRestoreConfigArg(runDir),
	).CombinedOutput()
	if err != nil {
		combined := string(restoreOut)
		// hardware-corrections C4/C8: a disk-lock failure ("Error locking disk
		// images", "Failed to get Write lock") is the signature of a writable golden
		// rootfs under concurrent standbys, not a generic restore failure — name it
		// so a future reader who has not read the tutorial still recognises it.
		// (This launcher never sets readonly=off; if this fires, the golden
		// snapshot's own config.json's disks[].readonly is the place to check —
		// that is a build-pipeline concern, not this launcher's argv.)
		//
		// Fix round 7 makes this diagnostic MORE precise, not less: rewriteSnapshotConfig
		// now points every standby's disks[].path at the exact same file —
		// filepath.Join(l.opts.SnapshotDir, fileRootfs) — so if this fires, it is not
		// "some golden rootfs, maybe this one", it is THE literal shared file every
		// concurrent standby just tried to open. That sharing is exactly what C4/C8's
		// readonly=on SharedRead lock is FOR (verified on the rig: SharedRead locks
		// coexist; a writable open is refused while any exist), so naming the path
		// directly turns "is the golden rootfs not read-only?" from a rhetorical
		// question into a concrete file to go check.
		if chvLooksLikeDiskLockError(combined) {
			sharedRootfs := filepath.Join(l.opts.SnapshotDir, fileRootfs)
			return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: disk-lock error (shared golden rootfs %s is not read-only? see hardware-corrections C4/C8): %s", req.ID, sharedRootfs, combined), cleanup())
		}
		// hardware-corrections C3: a guest that panics for lack of `root=` on the
		// cmdline produces exactly this symptom from ch-remote's point of view — a
		// failed restore/resume with no further detail — so console output is
		// included here rather than only in the API-socket-timeout path above. Round
		// 12: both output files are included, not just vmmStdio's — see the CH-spawn
		// block's doc comment above for why neither one alone can be trusted to
		// carry cloud-hypervisor's own words.
		return nil, errors.Join(fmt.Errorf("cloud-hypervisor: restore %s: ch-remote restore: %w: %s (vmm stdio: %s) (cloud-hypervisor log: %s)", req.ID, err, combined, chvReadConsole(console.Name()), chvReadConsole(chvLogPath)), cleanup())
	}

	return &chvVM{
		id:        req.ID,
		key:       req.Key,
		vmmCmd:    vmmCmd,
		fsCmd:     fsCmd,
		runDir:    runDir,
		apiSock:   apiSock,
		vsockSock: vsockSock,
		vsockPort: l.opts.VsockPort,
		chRemote:  l.opts.ChRemoteBin,
		console:   console,
		chvLog:    chvLogPath,
		fsConsole: fsConsole,
		// Empty unless ParentCgroup placed this VM in a systemd scope — see
		// StandbyBytes. Computed from the SAME three naming authorities the orphan
		// sweep recognises (cgroup.go's naming block), never retyped inline.
		scopeCgroup: chvScopeCgroupDir(l.opts.ParentCgroup, req.ID),
	}, nil
}

// chvRestoreConfigArg builds the single argument ch-remote's restore subcommand
// takes. Confirmed against the real ch-remote CLI source
// (cloud-hypervisor/src/bin/ch-remote.rs: Command::new("restore").arg(Arg::new(
// "restore_config").index(1).required(true)...)) and against `ch-remote restore
// --help` on the installed v53.0: unlike pause and resume (each a bare,
// argument-less subcommand upstream — confirmed the same way; see chvVM.Resume's
// call site below, which is already correct and unchanged by this fix), restore
// takes exactly ONE required POSITIONAL argument — a comma-separated key=value
// string — not a set of flags. This file previously passed "--source-url
// file://<dir>" as if source_url were its own flag; ch-remote rejects that with
// "error: unexpected argument '--source-url' found" (exit status 2). source_url
// is one field inside the single positional string, nothing more.
//
// resume=false is passed explicitly, not left to whatever ch-remote currently
// defaults it to: standbys are restored PAUSED, not running. A paused VM costs
// zero CPU, which is what lets many standbys exist without burning cores on timer
// ticks (spec §3.2); Resume is a deliberately separate step (chvVM.Resume,
// below) — mirroring fcapi.go's ResumeVM field, which makes the identical
// argument on the Firecracker arm. Being explicit here is what stops a future
// upstream default change from silently turning every restored standby into a
// running VM.
//
// v53.0's restore_config syntax, verbatim from `ch-remote restore --help`:
//
//	source_url=<source_url>,prefault=on|off,memory_restore_mode=copy|ondemand,
//	net_fds=<list_of_net_ids_with_their_associated_fds>,resume=true|false
//
// Note memory_restore_mode enumerates only copy|ondemand on this version — no
// CopyOnWrite value exists here. See the task-16 report: this confirms an open
// question the reference tutorial flagged, and bears on whether spec §7.3's
// memory arithmetic transfers to this arm at all (a Task 21 question).
func chvRestoreConfigArg(runDir string) string {
	return "source_url=file://" + runDir + ",resume=false"
}

// chvReadConsole best-effort reads back a captured-output log file for inclusion
// in an error message — generic over which one: the wrapper-stdio file
// (vmmCmd.Stdout/Stderr's own "vmm-stdio.log") and cloud-hypervisor's own
// --log-file ("cloud-hypervisor.log") are both plain paths on disk, so this one
// helper serves both (task-16 report, round 12). Never itself a source of a new
// failure: on any error it returns a placeholder string rather than propagating.
func chvReadConsole(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return "(console unavailable: " + err.Error() + ")"
	}
	if len(b) == 0 {
		return "(console empty)"
	}
	return string(b)
}

// chvLooksLikeDiskLockError recognises the exact error text hardware-corrections
// C4/C8 captured on real hardware for a write-locked disk image.
func chvLooksLikeDiskLockError(s string) bool {
	return containsAny(s, "Error locking disk images", "Failed to get Write lock", "AlreadyLocked")
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if sub != "" && strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// chvVM is one restored Cloud Hypervisor standby, holding both host processes
// (cloud-hypervisor and its own virtiofsd) and the per-VM socket paths
// rewriteSnapshotConfig baked into its own config.json copy.
type chvVM struct {
	id, key string

	vmmCmd    *exec.Cmd // cloud-hypervisor
	fsCmd     *exec.Cmd // virtiofsd
	runDir    string
	apiSock   string
	vsockSock string
	vsockPort uint32
	chRemote  string
	console   *os.File // the directly-spawned process's stdout/stderr (systemd-run's, when ParentCgroup wraps CH — see the Restore CH-spawn block's doc comment)
	chvLog    string   // path cloud-hypervisor was told via --log-file to write ITS OWN log to; not an *os.File because this process never opens it, CH does (round 12, task-16 report)
	fsConsole *os.File // virtiofsd's stdout/stderr

	mu        sync.Mutex
	destroyed bool

	// scopeCgroup is this VM's systemd scope cgroup directory on cgroupfs, empty
	// when ParentCgroup is unset (nothing placed the VM in a scope, so there is no
	// footprint to read and standbyChargeLocked charges full price). Used only by
	// StandbyBytes; guarded by mu alongside the footprint cache below.
	scopeCgroup string
	// The standby footprint cache (#644), same shape and same reasoning as
	// firecrackerVM's: read once on the first StandbyBytes call, error included,
	// never retried.
	standbyFootprint    int64
	standbyFootprintErr error
	standbyFootprintSet bool
}

func (v *chvVM) Key() string { return v.key }

// ID is the per-VM id that names the run dir and the scope (read by vmID for the exec audit line).
func (v *chvVM) ID() string { return v.id }

// chvScopeCgroupDir is the cgroupfs directory systemd materialises for one VM's
// `systemd-run --scope` unit: Cgroup2Root + the slice-relative ParentCgroup +
// chvScopeUnitName(vmID) + ".scope". Built from the SAME naming authorities the
// orphan sweep recognises (cgroup.go's naming block: Cgroup2Root, ParentCgroup,
// chvScopeUnitName, chvScopeDirSuffix) so the reader and the sweep cannot drift
// onto different directories — exactly the drift that class of block exists to
// prevent. Empty when parentCgroup is unset, matching the field's own contract.
// systemd expands a dashed slice name into a hierarchy, so the two-segment
// ParentCgroup ("microvm.slice/microvm-vms.slice") is already the full path under
// the mount; see DefaultParentCgroup's hardware-verified comment.
func chvScopeCgroupDir(parentCgroup, vmID string) string {
	if parentCgroup == "" {
		return ""
	}
	return filepath.Join(Cgroup2Root, parentCgroup, chvScopeUnitName(vmID)+chvScopeDirSuffix)
}

// StandbyBytes implements standbyFootprinter (budget.go): this paused VM's
// dirty-page cost, read from its systemd scope cgroup's memory.current. Same
// cache-once reasoning as firecrackerVM.StandbyBytes: a paused VM's footprint is
// static (vcpus stopped), so the first answer is the answer, and one cgroupfs
// syscall per standby per lifetime beats one per admission check.
func (v *chvVM) StandbyBytes() (int64, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.standbyFootprintSet {
		return v.standbyFootprint, v.standbyFootprintErr
	}
	v.standbyFootprintSet = true
	if v.scopeCgroup == "" {
		v.standbyFootprintErr = fmt.Errorf("cloud-hypervisor VM %s: no scope cgroup to read (ParentCgroup unset?)", v.id)
		return 0, v.standbyFootprintErr
	}
	v.standbyFootprint, v.standbyFootprintErr = readMemoryCurrent(v.scopeCgroup)
	return v.standbyFootprint, v.standbyFootprintErr
}

// Resume unpauses the VM via ch-remote. It does NOT mount the workspace — round 8
// moved that into Run, deliberately, not as an oversight this comment used to claim
// the opposite of (see chvWrapCommand's doc comment for the full reasoning: a
// virtio-fs session is a live connection to a per-VM virtiofsd whose socket
// rewriteSnapshotConfig redirects on every restore, and this codebase already
// distrusts anything analogous surviving a snapshot boundary — established vsock
// connections do not, only listening ones do (runOverConn's doc comment) — so the
// mount is not trusted to have survived restore either, and is redone fresh inside
// Run's own single round-trip instead of a separate call here).
//
// Audited against the real ch-remote CLI source alongside the restore-argv fix
// above (task-16 report, round 6): "resume" is a bare, argument-less subcommand
// upstream (Command::new("resume").about("Resume the VM"), dispatched with a nil
// body) — this call site already matches that and needs no change. There is no
// "pause" call site anywhere in this launcher to audit; restores land the VM
// already paused via restore_config's resume=false (chvRestoreConfigArg), so this
// codebase never needs to pause one itself.
func (v *chvVM) Resume(ctx context.Context) error {
	if err := v.checkNotDestroyed(); err != nil {
		return err
	}
	out, err := exec.CommandContext(ctx, v.chRemote, "--api-socket", v.apiSock, "resume").CombinedOutput()
	if err != nil {
		// Round 12 (task-16 report): both output files are folded in, for the same
		// reason Restore's own failure paths fold both in — see the CH-spawn block's
		// doc comment in Restore.
		return fmt.Errorf("cloud-hypervisor: resume %s: %w: %s (vmm stdio: %s) (cloud-hypervisor log: %s)", v.id, err, out, chvReadConsole(v.console.Name()), chvReadConsole(v.chvLog))
	}
	return nil
}

// chvWorkspaceTag and chvWorkspaceMountPoint are the two ends of the host/guest
// virtio-fs contract (round 8): build-snapshot.sh's `--fs tag=workspace,socket=...`
// attaches the device under this tag; chvWrapCommand below mounts it at this path.
// Pinned as named constants — not inlined string literals — so a rename on either
// side of that contract is a one-line diff here, and so a test can assert against
// the literal values rather than merely against "whatever this function currently
// does."
const (
	chvWorkspaceTag        = "workspace"
	chvWorkspaceMountPoint = "/workspace"

	// chvMountFailMarker is written to the GUEST's stderr, and ONLY there, the
	// instant chvWrapCommand's mount step fails — before the user's own command
	// ever starts. chvMountFailSink watches for it so Run can tell "the mount
	// failed" apart from "the user's command happened to exit with some identical
	// code" without remapping the command's own exit status, which Run must never
	// do (see chvWrapCommand's comment on preserving it exactly, same as
	// Firecracker's wrapCommand). It cannot collide with real command output: the
	// mount branch is the only producer of this exact line, and it is unreachable
	// once the user's command has started.
	chvMountFailMarker = "CHV-WORKSPACE-MOUNT-FAILED"
)

// chvWrapCommand mounts the workspace, then runs cmd, preserving cmd's own exit
// code exactly the way Firecracker's wrapCommand preserves its command's exit code
// (`(exit $__fc_rc)`) — with two differences from that function, both spelled out
// here because the two wrappers sit side by side in this codebase and must not read
// as accidentally inconsistent:
//
//  1. WHERE the mount happens, and how often. Firecracker mounts once, in Resume,
//     because mounting a real block device also re-reads its metadata (spec §4.3)
//     and a Firecracker VM never shares its disk with another guest. Cloud
//     Hypervisor's virtio-fs mount is instead embedded HERE, in Run's own single
//     command, redone on every Exec: whether a virtio-fs session survives
//     snapshot/restore with its backing socket redirected to a fresh per-VM
//     virtiofsd (rewriteSnapshotConfig's fs[].socket rewrite) is unverified, and
//     this codebase already documents the analogous failure shape for vsock —
//     established connections do not survive resume, only listening ones do
//     (runOverConn's doc comment) — so a mount baked into the golden snapshot is no
//     more trusted to have survived restore than a connection would be. Embedding
//     it in Run's own round-trip, rather than a separate Resume-time call, also
//     means there is no window where Resume could report success on a mount that
//     silently didn't take.
//
//  2. NO sync. This is the one deliberate, load-bearing asymmetry with Firecracker's
//     wrapCommand that this file's package comment and Run's own comment already
//     call out: virtio-fs writes land on the HOST filesystem the moment the guest
//     issues them, so there is no guest page cache standing between a write and
//     durability the way there is for Firecracker's ext4 workspace image. Adding a
//     sync here would be cargo-culted from the other arm, not a fix for anything
//     this arm actually has wrong.
//
// Idempotency: this does NOT check "already mounted" and skip if so, the way
// Firecracker's Resume does (`mountpoint -q /workspace || mount ...`). That check
// is safe for Firecracker because its workspace is a directly-attached block device
// with no daemon in the loop — an already-mounted /workspace is trivially still
// correct there. Cloud Hypervisor's mount is backed by a per-VM virtiofsd reached
// over a socket rewriteSnapshotConfig rewrites on every single restore; a
// /workspace that LOOKS already mounted (e.g. carried in the golden snapshot's
// captured guest state) could be a stale session pointed at a virtiofsd that no
// longer exists — which is precisely the "lost write" failure round 8 exists to
// fix, not a state safe to leave alone. So this unmounts first (tolerating "not
// mounted") and always remounts fresh, on every single Exec, rather than trusting
// anything carried across a restore.
func chvWrapCommand(cmd string) string {
	return "if mountpoint -q " + chvWorkspaceMountPoint + " 2>/dev/null; then umount " + chvWorkspaceMountPoint + "; fi\n" +
		"__chv_mount_err=$(mount -t virtiofs " + chvWorkspaceTag + " " + chvWorkspaceMountPoint + " 2>&1)\n" +
		"if [ $? -ne 0 ]; then\n" +
		"  echo \"" + chvMountFailMarker + ": tag=" + chvWorkspaceTag + " mountpoint=" + chvWorkspaceMountPoint + ": ${__chv_mount_err}\" >&2\n" +
		"  exit 97\n" +
		"fi\n" +
		"cd " + chvWorkspaceMountPoint + "\n" +
		"{ " + cmd + "\n}\n" +
		"__chv_rc=$?\n" +
		"(exit $__chv_rc)\n"
}

// chvMountFailSink wraps the caller's real Sink and watches stderr for
// chvMountFailMarker. When chvWrapCommand's mount step fails, that marker is the
// ONLY thing written to stderr before the wrapper exits (the user's own command
// never starts on that branch), so this sink intercepts and holds those bytes
// instead of forwarding them: a mount failure is an infrastructure error, surfaced
// by Run as a returned Go error, not something that should appear as if the user's
// own command produced it. Every other byte on either stream passes straight
// through untouched.
type chvMountFailSink struct {
	out    Sink
	failed bool
	detail []byte
}

func (s *chvMountFailSink) Stdout(b []byte) { s.out.Stdout(b) }

func (s *chvMountFailSink) Stderr(b []byte) {
	if s.failed || bytes.Contains(b, []byte(chvMountFailMarker)) {
		s.failed = true
		s.detail = append(s.detail, b...)
		return
	}
	s.out.Stderr(b)
}

// Run sends exactly one command over a fresh vsock connection: chvWrapCommand's
// mount-then-run script, never a command kind's c.Command unwrapped (a process kind,
// which this arm never serves, is sent as given: wrapForGuest). See chvWrapCommand's doc
// comment for why the mount lives here rather than in Resume, and why there is
// still no sync — the one deliberate asymmetry with the Firecracker arm's
// Run/wrapCommand, load-bearing per spec §4.3 (the host filesystem, not a guest
// page cache, is this arm's durability authority) and not an omission for a reader
// diffing the two wrappers to conclude sync was forgotten.
//
// A mount failure never reaches the caller as an ordinary command result: it is
// detected via chvMountFailSink and turned into a returned error naming both the
// tag and the mount point, specifically so it cannot present as a lost write —
// which is exactly the symptom round 8 exists to fix, and exactly what a silent
// failure here would reproduce.
func (v *chvVM) Run(ctx context.Context, c Command, out Sink) (Result, error) {
	if err := v.checkNotDestroyed(); err != nil {
		return Result{}, err
	}
	conn, err := dialVsock(v.vsockSock, v.vsockPort)
	if err != nil {
		return Result{}, fmt.Errorf("cloud-hypervisor: run %s: dial vsock: %w", v.id, err)
	}
	wrapped := wrapForGuest(c, chvWrapCommand) // a process kind is never wrapped (P5-R34)
	sink := &chvMountFailSink{out: out}
	res, err := runOverConn(ctx, conn, wrapped, sink, time.Now())
	if err != nil {
		return res, err
	}
	if sink.failed {
		return Result{}, fmt.Errorf("cloud-hypervisor: run %s: mount workspace (tag=%q, mountpoint=%q) failed: %s",
			v.id, chvWorkspaceTag, chvWorkspaceMountPoint, strings.TrimSpace(string(sink.detail)))
	}
	return res, nil
}

// Destroy SIGKILLs the VMM first, then virtiofsd (per the brief), reaps both, and
// removes the per-VM run directory (which holds both sockets and the per-VM
// config.json copy). Idempotent, mirroring launcher_firecracker.go's Destroy.
//
// hardware-corrections C10: cloud-hypervisor's Linux `comm` field is truncated to
// "cloud-hyperviso" (15 chars), so pgrep/pkill -x cloud-hypervisor NEVER matches —
// a silent no-op that would report success having killed nothing. This is exactly
// why both processes are killed by the *os.Process handle this struct already
// holds, never by searching for a name.
func (v *chvVM) Destroy() error {
	v.mu.Lock()
	if v.destroyed {
		v.mu.Unlock()
		return nil
	}
	v.destroyed = true
	vmmCmd, fsCmd, console, fsConsole := v.vmmCmd, v.fsCmd, v.console, v.fsConsole
	v.mu.Unlock()

	var errs []error
	for _, cmd := range []*exec.Cmd{vmmCmd, fsCmd} { // VMM first, then virtiofsd
		if cmd == nil || cmd.Process == nil {
			continue
		}
		pid := cmd.Process.Pid
		if err := fcKillProcessGroup(pid); err != nil && !fcProcessNotFound(err) {
			errs = append(errs, fmt.Errorf("kill -%d: %w", pid, err))
		}
		_ = cmd.Wait() // reap; "signal: killed" is the expected outcome, not a failure
	}
	if console != nil {
		_ = console.Close()
	}
	if fsConsole != nil {
		_ = fsConsole.Close()
	}
	if err := os.RemoveAll(v.runDir); err != nil {
		errs = append(errs, fmt.Errorf("remove run dir %s: %w", v.runDir, err))
	}
	return errors.Join(errs...)
}

func (v *chvVM) checkNotDestroyed() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.destroyed {
		return fmt.Errorf("cloud-hypervisor: VM %s: used after Destroy", v.id)
	}
	return nil
}

// chvIsolateAndDropPrivileges puts cmd in its own process group (same reasoning as
// fcIsolateProcessGroup: fcKillProcessGroup's -pid kill must reach every process
// this one spawns, without also reaching this launcher's own group) and, when uid
// and gid are both nonzero, drops the child's privileges to that uid/gid before
// exec via SysProcAttr.Credential. uid==0 (used for the cloud-hypervisor process
// itself, which this arm does not run under a dedicated unprivileged account) is a
// no-op sentinel for "isolate only, do not touch credentials" — validate() already
// refuses uid/gid 0 for virtiofsd specifically, so this parameter combination is
// never used to smuggle a root virtiofsd past that check.
func chvIsolateAndDropPrivileges(cmd *exec.Cmd, uid, gid int) {
	chvIsolateAndDropPrivilegesPlatform(cmd, uid, gid)
}
