package vmpool

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// This file is the Firecracker arm of Launcher (spec §4.3, §5.3). Two things about
// it are load-bearing enough to say once, here, rather than repeat at every call
// site:
//
// PROCESS LIFETIME. The jailer/firecracker process Restore starts must outlive the
// context Restore itself was called with — that ctx is a per-warm or per-Probe
// context that is cancelled the moment THAT call returns, long before the VM it
// created is done being useful. So Restore uses exec.Command, never
// exec.CommandContext, for that one process, and hands the *exec.Cmd to the
// returned VM so Destroy (deferred unconditionally by every caller, per
// pool.go's ExecPhased) is what ends its life, not ctx cancellation.
//
// TWO CONFIRMED GAPS THIS TASK DOES NOT CLOSE. deploy/microvm/build-snapshot.sh
// (a) runs firecracker directly, unjailed, and records the rootfs drive's
// path_on_host as an absolute path inside a `mktemp -d` staging directory that is
// deleted (`trap 'rm -rf "$STAGE"' EXIT`) once the build finishes, and (b) never
// configures a second (workspace) drive at all — there is no PUT /drives/workspace
// call anywhere in it. Firecracker's snapshot/load API has no restore-time
// override for a drive's path_on_host (unlike vsock, which has vsock_override —
// see fcapi.go) or for an absent device, so this launcher cannot make either gap
// disappear from inside Restore. What it does instead: hardlink every snapshot
// component AND workspace.img into the jail at the FIXED, jail-relative paths a
// FIXED build script would need to have recorded in vmstate for LoadSnapshot to
// find them (see Restore's comments below for exactly which paths). Until
// build-snapshot.sh is changed to build under that same convention, restoring a
// snapshot the CURRENT script produced will fail at LoadSnapshot with a
// fault_message naming the missing/wrong path — loudly, not silently. See the
// task-15 report for the full writeup; this is a blocker for whichever task owns
// the build pipeline next, not something Task 15's interface work can paper over.
const (
	// DefaultWorkspaceImageBytes sizes workspace.img when FirecrackerOptions leaves
	// WorkspaceImageBytes unset. 2 GiB matches the brief's own test fixtures.
	DefaultWorkspaceImageBytes int64 = 2 << 30
	// defaultFCVsockPort is cmd/guest-agent/main.go's own default ("vsock:1024") —
	// duplicated here as a fallback rather than imported, since importing
	// cmd/guest-agent from internal/vmpool would be a binary-to-package dependency
	// pointing the wrong way.
	defaultFCVsockPort uint32 = 1024

	// apiSockRelPath and vsockRelPath are jail-relative (i.e. as Firecracker itself,
	// running chrooted, sees them): "/" here means jailRoot on the host side. Fixed
	// rather than derived from anything per-VM, because nothing about them needs to
	// vary — every jail is a fresh, disposable root.
	apiSockRelPath = "/run/firecracker.socket"
	vsockRelPath   = "/run/v.sock"

	// defaultEgressVsockPort is the guest-initiated vsock port the guest agent's egress splice
	// connects to (P4.1 §6). Firecracker maps a guest connect to it onto the host unix socket
	// <vsock uds_path>_<port>, i.e. <jail>/run/v.sock_1025.
	defaultEgressVsockPort uint32 = 1025
)

// egressControlTimeout bounds each Register and Unregister round trip to moca-egress.
const egressControlTimeout = 5 * time.Second

// FirecrackerOptions configures the Firecracker launcher.
type FirecrackerOptions struct {
	SnapshotDir    string // golden snapshot dir: vmstate, memfile, kernel, rootfs, agent, manifest.json (snapshot.go)
	JailerBin      string
	FirecrackerBin string
	ChrootBase     string // jailer's --chroot-base-dir

	UID, GID int // jailer's --uid/--gid: the unprivileged user the jailed firecracker process runs as

	// ParentCgroup is jailer's --parent-cgroup. It MUST be configured consistently
	// with the systemd slice Task 17 defines (spec §5.3: "they must be configured
	// consistently ... or the two mechanisms fight and the leak we are preventing
	// returns"). Left empty, jailer's own default cgroup placement is used and
	// --cgroup-version/--parent-cgroup are omitted entirely — Restore does not
	// guess a value Task 17 has not defined yet.
	ParentCgroup string

	// cgroupRoot overrides where the cgroup pool roots its directories. Unexported, so nothing
	// outside this package can set it: it exists so a test can drive a REAL restore against a
	// temporary cgroup tree, because Cgroup2Root is a const naming the host's actual cgroupfs and
	// a test cannot create a cgroup there without root. Empty means Cgroup2Root, which is every
	// production path.
	cgroupRoot string

	// CgroupMemoryMaxBytes is the per-VM cgroup's memory.max, and since #258 it is written by
	// cgroupPool rather than by jailer. jailer is no longer told to create a per-VM cgroup at all:
	// --cgroup was the flag that did that, and creating one per VM cost 195.52 ms of a 253 ms
	// Destroy at 64 concurrency slots plus an unbounded dying-cgroup population. The pool creates
	// the cgroup, writes this bound, and jailer is given only --parent-cgroup, which relocates the
	// jailed process into a cgroup that already exists.
	//
	// The FIGURE is unchanged: PerVMBytes(cfg), the same one admission control charges (D1), so the
	// kernel-enforced ceiling and the software gate still agree. It matters MORE than before, not
	// less: writeMemoryMax rejects <= 0, so a zero here now fails every restore rather than
	// silently omitting a flag. validate() refuses that combination at construction.
	CgroupMemoryMaxBytes int64

	// WorkspaceImageBytes sizes the lazily-created workspace.img ext4 filesystem
	// (the second drive, guest /dev/vdb). Created once per run (RestoreRequest.
	// WorkspaceDir) on first Restore into that workspace, then hardlinked into every
	// VM subsequently restored for the same run. Defaults to DefaultWorkspaceImageBytes
	// when <= 0.
	WorkspaceImageBytes int64

	// VsockPort is the guest agent's listen port. Defaults to 1024 (the guest
	// agent's own default) when zero.
	VsockPort uint32

	// Egress, when non-nil, turns guest egress on: every restored VM gets a host listener at
	// <jail>/run/v.sock_<EgressPort> that is registered with moca-egress before the VM can
	// become a standby. Nil is today's behaviour: no listener, nothing registered.
	Egress EgressBinder
	// EgressPort is the guest-initiated vsock port. Defaults to 1025 when zero.
	EgressPort uint32
}

func (o *FirecrackerOptions) setDefaults() {
	if o.VsockPort == 0 {
		o.VsockPort = defaultFCVsockPort
	}
	if o.WorkspaceImageBytes <= 0 {
		o.WorkspaceImageBytes = DefaultWorkspaceImageBytes
	}
	if o.EgressPort == 0 {
		o.EgressPort = defaultEgressVsockPort
	}
}

// maxEgressSocketPath is the longest egress socket path any VM id can produce under this
// configuration: jailer's <chroot-base>/<exec basename>/<id>/root layout, with the longest id
// nextIDLocked can mint ("vm-" plus a 20-digit uint64), plus the vsock path and "_<port>".
func (o FirecrackerOptions) maxEgressSocketPath() string {
	return o.ChrootBase + "/" + filepath.Base(o.FirecrackerBin) + "/vm-" + strings.Repeat("9", 20) +
		"/root" + vsockRelPath + "_" + strconv.FormatUint(uint64(o.EgressPort), 10)
}

// egressSocketPath is the host path of VM jailRoot's egress listener.
func (o FirecrackerOptions) egressSocketPath(jailRoot string) string {
	return filepath.Join(jailRoot, vsockRelPath) + "_" + strconv.FormatUint(uint64(o.EgressPort), 10)
}

func (o FirecrackerOptions) validate() error {
	switch {
	case o.SnapshotDir == "":
		return errors.New("firecracker: SnapshotDir is required")
	case o.JailerBin == "":
		return errors.New("firecracker: JailerBin is required")
	case o.FirecrackerBin == "":
		return errors.New("firecracker: FirecrackerBin is required")
	case o.ChrootBase == "":
		return errors.New("firecracker: ChrootBase is required")
	case o.ParentCgroup != "" && o.CgroupMemoryMaxBytes <= 0:
		// D1: a ParentCgroup with no memory bound is exactly the half-wired state the
		// hardware corrections found in committed code. The check is unchanged and matters MORE
		// since #258 moved the write out of jailer: cgroupPool calls writeMemoryMax, which
		// rejects <= 0, so a zero here fails every restore rather than silently omitting a flag.
		// Fail loudly at construction instead.
		return errors.New("firecracker: ParentCgroup is set but CgroupMemoryMaxBytes is <= 0 " +
			"— the cgroup pool could not write a memory.max for the VMs it creates, so every " +
			"restore would fail (spec §6 mitigation #3 would be unimplemented); set it from " +
			"vmpool.PerVMBytes(cfg)")
	}
	// bind(2) fails on a path that does not fit sun_path (108 on Linux, 104 elsewhere), and it
	// would do so per VM at restore time, as an opaque error. Refuse at construction instead,
	// against the worst-case id. Only when egress is on: with it off the egress socket is never
	// bound and this constraint does not exist.
	if o.Egress != nil {
		if p := o.maxEgressSocketPath(); len(p) >= len(syscall.RawSockaddrUnix{}.Path) {
			return fmt.Errorf("firecracker: egress socket path %q is %d bytes, which does not fit "+
				"sun_path (%d bytes including the terminator); shorten ChrootBase (SH_CHROOT_BASE)",
				p, len(p), len(syscall.RawSockaddrUnix{}.Path))
		}
	}
	return nil
}

// firecrackerCgroupArgs returns the jailer cgroup flags: --cgroup-version 2 (D2: jailer's
// own default is version "1", which this cgroup2-only host does not have — always pass 2
// explicitly) and --parent-cgroup, which relocates the jailed process into the pooled
// cgroup cgroupPool already created under Task 17's systemd slice (spec §5.3).
//
// It creates nothing and bounds nothing itself, and deliberately returns no --cgroup — #319
// removed that flag, and the body says why. D1's per-VM memory.max is not lost, only moved:
// cgroupPool writes it on that pooled cgroup, from the same PerVMBytes admission control
// charges.
//
// Split out of Restore's argv construction so a test can assert those flags — and the
// absence of --cgroup — without spawning jailer. The bound itself is asserted off the pool,
// in the same test (cgroup_test.go).
func firecrackerCgroupArgs(parentRel string) []string {
	if parentRel == "" {
		return nil
	}
	// NO --cgroup (#258). That flag is what CREATES a per-VM cgroup, and creating one per VM cost
	// 195.52 ms of a 253 ms Destroy at 64 slots plus an unbounded dying-cgroup population.
	// --parent-cgroup alone relocates the jailed process into a cgroup that ALREADY EXISTS, which
	// cgroupPool created and on which it wrote memory.max = PerVMBytes -- so D1's bound still
	// applies to every VM, from the same figure admission control charges, just written by us
	// rather than by jailer.
	//
	// --cgroup-version 2 stays explicit: jailer's own default is "1", which this cgroup2-only host
	// does not have (D2).
	return []string{"--cgroup-version", "2", "--parent-cgroup", parentRel}
}

// firecrackerLauncher is the Firecracker arm of Launcher.
type firecrackerLauncher struct {
	opts FirecrackerOptions
	// cgroups hands out reusable per-VM cgroups (#258). Nil when ParentCgroup is unset, in which
	// case jailer's own default placement is used and there is no cgroup of ours at all.
	cgroups *cgroupPool
}

// NewFirecrackerLauncher validates opts, applies defaults, and returns a Launcher.
// It does not touch the filesystem or spawn anything — that is all deferred to
// Restore, off the hot path (spec §4.3).
func NewFirecrackerLauncher(opts FirecrackerOptions) (Launcher, error) {
	opts.setDefaults()
	if err := opts.validate(); err != nil {
		return nil, err
	}
	l := &firecrackerLauncher{opts: opts}
	if opts.ParentCgroup != "" {
		l.cgroups = newCgroupPool(opts.ParentCgroup, opts.CgroupMemoryMaxBytes, opts.cgroupRoot)
	}
	return l, nil
}

func (l *firecrackerLauncher) Kind() VMMKind { return Firecracker }

// checkDeviceSharing implements deviceRequirer. Restore hardlinks (os.Link, never
// a copy) every golden-snapshot component from l.opts.SnapshotDir, AND the
// per-run workspace image from cfg.WorkspaceRoot, into the jail under
// l.opts.ChrootBase — so all three must share one filesystem device or every
// Restore fails with EXDEV. The workspace image is hardlinked rather than copied
// deliberately: the run's workspace image must be the SAME INODE across that
// run's Execs, because that is how a file written in Exec N is still there in
// Exec N+1 (TestGateWriteDurability pins exactly this); a copy would silently
// break that durability guarantee instead of failing loudly, which is worse.
func (l *firecrackerLauncher) checkDeviceSharing(cfg Config) error {
	return checkPathsShareDevice(
		"Restore hardlinks the golden snapshot's components and the per-run "+
			"workspace image into the jail, and hardlink(2) cannot cross devices",
		namedPath{"FirecrackerOptions.SnapshotDir", l.opts.SnapshotDir},
		namedPath{"Config.WorkspaceRoot", cfg.WorkspaceRoot},
		namedPath{"FirecrackerOptions.ChrootBase", l.opts.ChrootBase},
	)
}

// SerializesExecsPerRun is true: the workspace is an ext4 image, not a shared-disk
// filesystem, and only one guest may hold its rw mount at a time (spec §4.3) — two
// concurrent Execs for the same run would mount it twice and corrupt it.
func (l *firecrackerLauncher) SerializesExecsPerRun() bool { return true }

// Restore brings up one VM from the golden snapshot into its own jail and returns
// it PAUSED. Every failure path below cleans up whatever it already created (kills
// any spawned process, removes the jail directory) and returns (nil, err) — never a
// non-nil VM alongside a non-nil error (spec §6: an early return here must not leak
// a jail or a process the caller has no handle to destroy).
func (l *firecrackerLauncher) Restore(ctx context.Context, req RestoreRequest) (VM, error) {
	// Refuse before spawning anything on a platform with no equivalent of the
	// process-group isolation (Setpgid/Kill) Destroy depends on — see
	// launcher_firecracker_unix.go / launcher_firecracker_other.go. Always nil on
	// unix; Firecracker/jailer are Linux-only regardless, but this is what turns a
	// non-unix build's failure into one clear message instead of an opaque exec
	// error deep inside cmd.Start.
	if err := fcPlatformSupported(); err != nil {
		return nil, fmt.Errorf("firecracker: restore %s: %w", req.ID, err)
	}
	// Jailer's own chroot convention: <chroot-base-dir>/<exec-file basename>/<id>/root.
	// UNVERIFIED against real hardware (none is available to this task — see the
	// task-15 report); this matches Firecracker's jailer documentation, but Task 16
	// or the first rig run should confirm it before trusting it further.
	// Restore phase timing, emitted only under SH_DIAG_PHASES (diag.go). The five
	// time.Now() calls are ~100ns against a restore measured in tens of MILLISECONDS,
	// so they are unconditional and only the log line is gated.
	phaseStart := time.Now()
	var phPrep, phWsImg, phSpawn, phSock time.Duration
	jailRoot := filepath.Join(l.opts.ChrootBase, filepath.Base(l.opts.FirecrackerBin), req.ID, "root")
	apiSockHost := filepath.Join(jailRoot, apiSockRelPath)

	// Refuse a jail some OTHER live VMM is still holding, before creating, spawning or
	// removing anything. Without this, an id collision is silently destructive in both
	// directions: waitForUnixSocket below DIALS (correctly — Firecracker creates the
	// socket file before it accept()s on it), so a leaked VMM's live listener reads as
	// this restore's own socket coming up, and LoadSnapshot lands on a microVM that is
	// already loaded. Firecracker answers "not supported after starting the microVM"
	// (400) — a message that names neither the collision nor the id, and points the
	// reader at the snapshot instead of at the leak. Then cleanup() runs
	// os.RemoveAll(jailRoot) against the LIVE foreign VM's jail while killing only the
	// process group of the jailer THIS call started, so the collided-with VM loses its
	// files and keeps running. That is exactly how E10 rung 4's teardown-bulk failed on
	// its first execution and still left a live firecracker behind afterwards.
	//
	// Fixing Close's in-flight-warm leak (see pool.Close) removes the cause this
	// branch actually hit, but not the class: SIGKILL, an OOM kill or a crash can
	// orphan a VMM no Close-side tidiness can reach, and vmpoolctl runs no startup
	// orphan sweep. A stale socket FILE with no listener is not a collision and must
	// not be treated as one — verified on the rig, where leftover jail directories
	// with no live process restored cleanly — so this asks the socket, not the
	// filesystem. See TestFirecrackerRefusesAJailALiveVMMStillHolds and its
	// free-jail converse.
	if fcJailOccupied(apiSockHost) {
		return nil, fmt.Errorf("firecracker: restore %s: a live VMM already holds this VM id's API socket at %s "+
			"— refusing to load a snapshot into another microVM (an earlier run leaked a VMM at this id; "+
			"kill it by cgroup membership under %s, never by process-name pattern)",
			req.ID, apiSockHost, l.opts.ParentCgroup)
	}

	// Acquired BEFORE the jailer starts, because jailer only relocates into --parent-cgroup if
	// that path already exists (#258). Released by Destroy, or by cleanup() on every failure path
	// below, so a failed restore does not strand it.
	var cgroupRel string
	if l.cgroups != nil {
		var cgErr error
		if cgroupRel, cgErr = l.cgroups.acquire(); cgErr != nil {
			return nil, fmt.Errorf("firecracker: restore %s: %w", req.ID, cgErr)
		}
	}

	var cmd *exec.Cmd
	// egressLn is the pre-bound guest-egress listener (nil when egress is off); egressRegistered
	// records that moca-egress holds a dup of it and must be told to let go.
	var egressLn *net.UnixListener
	egressRegistered := false
	// cleanup mirrors Destroy's error handling below: a failure here (permission,
	// EBUSY) must be surfaced, not swallowed, or the caller sees only the original
	// failure with no signal that a stale jail or process was left behind — the
	// same class of silent leak the never-return-a-VM rule exists to prevent, on
	// the error path instead of the happy path. It is exactly how a prior aborted
	// restore's leftovers cause the next restore's socket-already-in-use failure.
	cleanup := func() error {
		var errs []error
		if cmd != nil && cmd.Process != nil {
			pid := cmd.Process.Pid
			if err := fcKillProcessGroup(pid); err != nil && !fcProcessNotFound(err) {
				errs = append(errs, fmt.Errorf("kill -%d: %w", pid, err))
			}
			_ = cmd.Wait()
		}
		// SIGKILL, then Unregister, then unlink (P4.1 §6): nothing the dead guest could still
		// have in flight may reach a registration that is gone, and the path is unlinked last.
		// An Unregister failure is logged, not joined into errs: it is harmless (the server
		// unbinds everything a lost control connection owned) and must not read as a failed
		// teardown.
		if egressRegistered {
			uctx, ucancel := context.WithTimeout(context.WithoutCancel(ctx), egressControlTimeout)
			if err := l.opts.Egress.Unregister(uctx, req.ID); err != nil {
				log.Printf("vmpool: egress unregister %s during restore cleanup: %v", req.ID, err)
			}
			ucancel()
		}
		if egressLn != nil {
			_ = egressLn.Close() // unlinks the path (ListenUnix's unlink-on-close)
		}
		if err := os.RemoveAll(jailRoot); err != nil {
			errs = append(errs, fmt.Errorf("remove jail %s: %w", jailRoot, err))
		}
		// The same per-VM cgroup Destroy removes (#255), on the path that actually
		// provokes the leak. cleanup() runs after cmd.Start(), so jailer has already
		// created the cgroup by the time a sockwait timeout or a failed LoadSnapshot
		// gets here -- and every replenish retry draws a FRESH id from nextIDLocked, so
		// this leak is unbounded. A host that has started timing out on sockwait is
		// exactly the host that then accumulates directories fastest, which is the
		// feedback loop #255 measured at 5.3x. removeCgroupDir returns nil when the
		// directory was never created, so this is safe on the earlier error paths too.
		// RETURN the pooled cgroup rather than removing it (#258). This is the path #255 found
		// leaking a directory per failed restore -- a sockwait timeout or a failed LoadSnapshot,
		// each retry drawing a fresh id -- and pooling removes that leak by construction, because
		// there is nothing per-VM to leak. release() still refuses to reuse one with a process
		// left inside, so a half-started jailer cannot be handed to the next tenant.
		if cgroupRel != "" && l.cgroups != nil {
			l.cgroups.release(cgroupRel)
		}
		return errors.Join(errs...)
	}

	if err := os.MkdirAll(filepath.Join(jailRoot, "run"), 0o700); err != nil {
		return nil, errors.Join(fmt.Errorf("firecracker: restore %s: create jail: %w", req.ID, err), cleanup())
	}

	// The guest-egress listener, bound and listen()ing BEFORE cmd.Start below (P4.1 §6). Firecracker
	// maps a guest vsock connect to port N onto a connect(2) to <uds_path>_N, and a connect to a
	// path nobody is listening on is refused (E13 saw the guest RST when its listener was not up
	// yet). net.ListenUnix does bind+listen before it returns, so by the time the jailer exists
	// the socket is already accepting and the race is closed by construction rather than by a
	// retry. The VM is a standby only once Register succeeds: any failure here fails the restore,
	// so no VM is ever pooled without an egress policy owner (fail-closed).
	if l.opts.Egress != nil {
		sockPath := l.opts.egressSocketPath(jailRoot)
		_ = os.Remove(sockPath) // best-effort: a stale socket file from an aborted attempt at this ID
		ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sockPath, Net: "unix"})
		if err != nil {
			return nil, errors.Join(fmt.Errorf("firecracker: restore %s: egress listen %s: %w", req.ID, sockPath, err), cleanup())
		}
		egressLn = ln
		// Same reason as the hardlinks below: this process creates the socket, so it is owned
		// by whatever the launcher runs as, not by the uid/gid jailer drops to.
		if err := os.Lchown(sockPath, l.opts.UID, l.opts.GID); err != nil {
			return nil, errors.Join(fmt.Errorf("firecracker: restore %s: egress chown %s to %d:%d: %w", req.ID, sockPath, l.opts.UID, l.opts.GID, err), cleanup())
		}
		f, err := ln.File() // a dup; Register dups again, so this one is closed right after
		if err != nil {
			return nil, errors.Join(fmt.Errorf("firecracker: restore %s: egress listener fd: %w", req.ID, err), cleanup())
		}
		// Detached from ctx: on a cold acquire ctx is the Exec request's own, and a Register
		// abandoned mid-flight costs the shared control connection (which the client then
		// heals). Its own timeout still bounds the call.
		rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), egressControlTimeout)
		regErr := l.opts.Egress.Register(rctx, req.ID, req.Key, nil, f)
		rcancel()
		_ = f.Close()
		if regErr != nil {
			return nil, errors.Join(fmt.Errorf("firecracker: restore %s: egress register: %w", req.ID, regErr), cleanup())
		}
		egressRegistered = true
	}

	// Hardlink the golden snapshot's components into the jail at fixed, jail-relative
	// basenames. A hardlink (not a copy) keeps memfile a single page-cache object
	// shared across every VM restored from this snapshot, so Task 14's
	// PinMemoryFile mlock actually shares physical pages across VMs (spec §7.3)
	// rather than each VM privately mlocking its own copy.
	//
	// See this file's package-level comment for the rootfs path_on_host gap this
	// depends on build-snapshot.sh closing: LoadSnapshot below will fail against a
	// snapshot the CURRENT script produced, loudly, with Firecracker's own
	// fault_message identifying the path it could not find.
	for _, name := range []string{fileVMState, fileMemory, fileKernel, fileRootfs, fileAgent} {
		src := filepath.Join(l.opts.SnapshotDir, name)
		dst := filepath.Join(jailRoot, name)
		_ = os.Remove(dst) // best-effort: a stale link from an aborted prior attempt at this same ID
		if err := os.Link(src, dst); err != nil {
			return nil, errors.Join(fmt.Errorf("firecracker: restore %s: hardlink %s: %w", req.ID, name, err), cleanup())
		}
		if err := os.Chown(dst, l.opts.UID, l.opts.GID); err != nil {
			// Coordinator finding #3: the API socket (and, by the same mechanism, every
			// file this launcher pre-populates into the jail) is created by THIS
			// process, not by jailer's own resource-copying, so it is owned by
			// whatever this launcher runs as rather than by the uid/gid jailer drops
			// privileges to. Firecracker cannot open a hardlink it cannot read once
			// jailer setuid/setgid's into opts.UID/opts.GID, so this must be fatal
			// rather than logged-and-ignored.
			return nil, errors.Join(fmt.Errorf("firecracker: restore %s: chown %s to %d:%d: %w", req.ID, name, l.opts.UID, l.opts.GID, err), cleanup())
		}
	}

	// The workspace drive. Lazily created once per run (WorkspaceDir), then
	// hardlinked into every VM's jail restored for that run — multiple standbys for
	// one run share the same underlying image, which is safe precisely BECAUSE only
	// one of them is ever mounted rw at a time (SerializesExecsPerRun, spec §4.3).
	//
	// See this file's package-level comment for the absent-workspace-drive gap this
	// depends on build-snapshot.sh closing: nothing makes the guest see this file as
	// /dev/vdb until the golden image is built with that drive already attached.
	phPrep = time.Since(phaseStart)
	imgPath := filepath.Join(req.WorkspaceDir, "workspace.img")
	if err := ensureWorkspaceImage(ctx, imgPath, l.opts.WorkspaceImageBytes); err != nil {
		return nil, errors.Join(fmt.Errorf("firecracker: restore %s: workspace image: %w", req.ID, err), cleanup())
	}
	phWsImg = time.Since(phaseStart) - phPrep
	workspaceDst := filepath.Join(jailRoot, "workspace.img")
	_ = os.Remove(workspaceDst)
	if err := os.Link(imgPath, workspaceDst); err != nil {
		return nil, errors.Join(fmt.Errorf("firecracker: restore %s: hardlink workspace.img: %w", req.ID, err), cleanup())
	}
	if err := os.Chown(workspaceDst, l.opts.UID, l.opts.GID); err != nil {
		return nil, errors.Join(fmt.Errorf("firecracker: restore %s: chown workspace.img to %d:%d: %w", req.ID, l.opts.UID, l.opts.GID, err), cleanup())
	}

	// Jailer execve's into FirecrackerBin after chroot/cgroup/uid/gid setup rather
	// than forking — so cmd.Process.Pid names the eventual firecracker process too,
	// and Destroy's process-group kill below reaches it under the same pid. Setpgid
	// puts it in its own group so the kill reaches any helper thread/process
	// Firecracker's own vcpu/seccomp machinery spawns, without also reaching this
	// launcher's own process group (coordinator finding #2's neighbor: an unrelated
	// SIGKILL storm is exactly the kind of accident a shared pgid invites).
	//
	// UNVERIFIED against real hardware, same as jailRoot above (none is available
	// to this task — see the task-15 report): the flag shape itself (this exact
	// set of jailer flags, "--" as the separator before the jailed binary's own
	// argv, and putting --api-sock after it), AND the assumption that jailer
	// resolves --api-sock (and, symmetrically, vsock's uds_path/vsock_override)
	// relative to the jail root rather than to some other directory. If either
	// assumption is wrong, waitForUnixSocket below times out rather than failing
	// with a clear cause — that timeout is the first place to look.
	args := []string{
		"--id", req.ID,
		"--exec-file", l.opts.FirecrackerBin,
		"--uid", strconv.Itoa(l.opts.UID),
		"--gid", strconv.Itoa(l.opts.GID),
		"--chroot-base-dir", l.opts.ChrootBase,
	}
	// firecrackerCgroupArgs appends --cgroup-version and --parent-cgroup, and deliberately
	// not --cgroup: see its doc comment.
	args = append(args, firecrackerCgroupArgs(cgroupRel)...)
	// Coordinator finding #5: this launcher never issues PUT /network-interfaces —
	// standbys are headless by construction, not by omission. Nothing below adds one.
	args = append(args, "--", "--api-sock", apiSockRelPath)

	cmd = exec.Command(l.opts.JailerBin, args...)
	// NOT exec.CommandContext — see this file's package-level comment on process
	// lifetime. Stdin is deliberately left nil (not e.g. os.Stdin): a jailed process
	// that inherits a controlling terminal's stdin can be sent SIGTTIN and stop the
	// moment it tries to read from it, which from this launcher's side is
	// indistinguishable from a hang (coordinator finding #2).
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	fcIsolateProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		return nil, errors.Join(fmt.Errorf("firecracker: restore %s: start jailer: %w", req.ID, err), cleanup())
	}

	// phSpawn times cmd.Start() RETURNING, which is all it ever measured -- it used to be
	// logged as jailer_us and read as the jailer's work (#328). The jailer's actual chroot
	// construction happens after this and is now measured as jailersetup_us below.
	// ONE clock reading ends phSpawn and opens the boundary's window, so the two really do
	// start at the same instant. Taking a second time.Now() below charged the gap between them
	// -- two branches and a struct alloc -- to fcBind, because fcBind is computed as the
	// remainder of phSock. Nanoseconds against a 1 ms poll quantum, so it changed no conclusion,
	// but it made the claim below that the two halves partition phSock exactly untrue.
	spawnEnd := time.Now()
	phSpawn = spawnEnd.Sub(phaseStart) - phPrep - phWsImg

	// The boundary observer is built only when diagnostics are on. Unlike the phase clocks --
	// five time.Now() calls at ~100 ns against a restore measured in tens of milliseconds -- this
	// one costs a procfs read per poll iteration, so the production path must not pay it.
	var boundary *fcExecBoundary
	if phaseLog != nil && cmd.Process != nil {
		boundary = newFCExecBoundary(cmd.Process.Pid, l.opts.FirecrackerBin, spawnEnd)
	}
	var observe func()
	if boundary != nil {
		observe = boundary.observe
	}
	if err := waitForUnixSocketObserved(ctx, apiSockHost, 5*time.Second, observe); err != nil {
		return nil, errors.Join(fmt.Errorf("firecracker: restore %s: API socket never appeared: %w", req.ID, err), cleanup())
	}

	phSock = time.Since(phaseStart) - phPrep - phWsImg - phSpawn
	fc := newFCClient(apiSockHost)
	// vsock_override redirects the vsock device's host-side socket to a path of OUR
	// choosing, rather than whatever uds_path build-snapshot.sh's guest_client.go
	// baked into the snapshot (an ephemeral staging path with the same "gone by
	// restore time" problem as rootfs's path_on_host — see the package comment).
	// This is the one restore-time path override Firecracker's snapshot/load API
	// actually offers (fcapi.go's vsockOverride doc comment), which is why Restore
	// uses it here instead of trying to guess or fix up the recorded path.
	fc.setVsockOverride(vsockRelPath)
	if err := fc.LoadSnapshot(ctx, filepath.Join("/", fileVMState), filepath.Join("/", fileMemory)); err != nil {
		return nil, errors.Join(fmt.Errorf("firecracker: restore %s: load snapshot: %w", req.ID, err), cleanup())
	}

	if phaseLog != nil {
		phLoad := time.Since(phaseStart) - phPrep - phWsImg - phSpawn - phSock
		ph := restorePhases{
			prep: phPrep, wsimg: phWsImg, spawn: phSpawn,
			sock: phSock, load: phLoad, total: time.Since(phaseStart),
		}
		// The two halves are set ONLY when the boundary was observed, so the struct is correct
		// where it is built rather than correct by a downstream override. With an unobserved
		// boundary, fcBind would otherwise be computed as phSock - 0 -- the whole window,
		// attributed to Firecracker -- and only logRestorePhases' -1 would stop it being logged.
		// That override stays as defence in depth for any future caller, and is what
		// TestRestorePhaseLineReportsAnUnobservedBoundaryAsMinusOne pins.
		//
		// jailerSetup is measured from spawnEnd, which is exactly where phSock's window opens,
		// so these two partition phSock rather than approximately partitioning it.
		if setup, seen := boundary.elapsed(); seen {
			ph.jailerSetup, ph.fcBind, ph.boundaryObserved = setup, phSock-setup, true
		}
		logRestorePhases(req.ID, ph)
	}
	return &firecrackerVM{
		id:            req.ID,
		key:           req.Key,
		cmd:           cmd,
		jailRoot:      jailRoot,
		cgroups:       l.cgroups,
		cgroupRel:     cgroupRel,
		apiSockHost:   apiSockHost,
		vsockHostPath: filepath.Join(jailRoot, vsockRelPath),
		vsockPort:     l.opts.VsockPort,
		egress:        l.opts.Egress,
		egressLn:      egressLn,
	}, nil
}

// The ext2/3/4 superblock lives at a fixed byte offset 1024 into the device, and its
// 16-bit magic at offset 0x38 within it — so 0x438 into the image, for every block size
// mkfs.ext4 can choose. That fixed position is what makes "is this file a formatted
// filesystem?" a question with an answer, rather than one inferred from the file
// existing.
const (
	ext4MagicOffset = 0x438
	ext4Magic       = 0xEF53
)

// mkfsExt4 formats path in place. A package var rather than a direct call so tests can
// substitute a formatter: mkfs.ext4 exists on the rig and on Linux CI, but not on a
// macOS developer machine, and the ordering property this file's tests pin (a half-built
// image is never at the final path) must be checkable everywhere — it is the property
// whose absence left durable 2 GiB zero-filled "images" behind.
var mkfsExt4 = func(ctx context.Context, path string) error {
	out, err := exec.CommandContext(ctx, "mkfs.ext4", "-F", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("mkfs.ext4 %s: %w: %s", path, err, out)
	}
	return nil
}

// workspaceImageFormatted reports whether path is a formatted ext4 image. Absent, short
// and zero-filled all answer false; only an unreadable file is an error.
func workspaceImageFormatted(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	defer func() { _ = f.Close() }()
	var b [2]byte
	if _, err := f.ReadAt(b[:], ext4MagicOffset); err != nil {
		// A file too short to hold a superblock is exactly the "created and Truncate'd
		// but never formatted" case in a different disguise, not an IO fault.
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return false, nil
		}
		return false, err
	}
	return binary.LittleEndian.Uint16(b[:]) == ext4Magic, nil
}

// ensureWorkspaceImage makes path a formatted, sparse ext4 filesystem of sizeBytes.
// Called at most once per run (WorkspaceDir is one run's directory, shared by every VM
// Restore creates for it), so the mkfs cost is paid once per run rather than once per VM.
//
// IT USED TO TREAT "THE FILE EXISTS" AS "THE FILE IS FORMATTED", while creating and
// Truncate'ing that very file well before mkfs ran on it. Two reachable outcomes, and
// this function is shaped to answer both:
//
//   - DURABLE. The worker is killed (or the ctx is cancelled and the cleanup Remove also
//     fails) between the Truncate and mkfs finishing. A 2 GiB zero-filled file then
//     persists, every later Restore for that run hardlinks it, and every `mount /dev/vdb`
//     in Resume fails for the whole WorkspaceIdle window with no self-healing. The magic
//     check above is what makes that file recognisable, so the next Restore rebuilds it
//     instead of inheriting it forever.
//   - CONCURRENT. A replenish timer firing while a cold warm is mid-mkfs for the same key
//     (both can hold warming — replenishOne only checks len(ready)+warming against
//     StandbyDepth) saw the file present, returned nil, and hardlinked an unformatted
//     image. The build now happens under a TEMP name in the same directory and is
//     link(2)'d into place, so nothing is ever visible at path until it is a finished
//     filesystem, and link — which refuses to clobber — means two concurrent builders
//     cannot leave two inodes fighting over one path.
//
// A build that dies part-way therefore leaves at most a temp file no Restore will ever
// hardlink, rather than something later treated as a valid image.
func ensureWorkspaceImage(ctx context.Context, path string, sizeBytes int64) error {
	if ok, err := workspaceImageFormatted(path); err != nil {
		return err
	} else if ok {
		return nil
	}
	tmp, err := buildWorkspaceImage(ctx, path, sizeBytes)
	if err != nil {
		return err
	}
	// After a successful Link the image is reachable by its real name, so dropping the
	// temp name leaves one link, not two; after a Rename this is a harmless ENOENT.
	defer func() { _ = os.Remove(tmp) }()

	switch err := os.Link(tmp, path); {
	case err == nil:
		return nil
	case !os.IsExist(err):
		return err
	}
	// Something appeared at path while we were building. If it is a real filesystem, a
	// concurrent builder won the race and its image is as good as ours.
	if ok, err := workspaceImageFormatted(path); err != nil {
		return err
	} else if ok {
		return nil
	}
	// It is not a filesystem: an unformatted leftover from the pre-fix code path (or from
	// a build killed between its own create and format). Replacing it IS the repair, and
	// rename is the one operation that does it atomically.
	return os.Rename(tmp, path)
}

// buildWorkspaceImage creates a sparse, formatted image under a temp name beside path and
// returns that name. The caller owns the temp file on every path, including error.
func buildWorkspaceImage(ctx context.Context, path string, sizeBytes int64) (string, error) {
	// CreateTemp opens 0o600 — the same mode the image was created with before this
	// function grew a temp name, and the mode Restore's chown to the jail UID/GID then
	// relies on.
	f, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".mkfs-*")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	fail := func(err error) (string, error) {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := f.Truncate(sizeBytes); err != nil {
		_ = f.Close()
		return fail(err)
	}
	if err := f.Close(); err != nil {
		return fail(err)
	}
	if err := mkfsExt4(ctx, tmp); err != nil {
		return fail(err)
	}
	return tmp, nil
}

// fcJailOccupied reports whether some live VMM is already accept()ing on path — the
// one-shot inverse of waitForUnixSocket's poll, and deliberately the same question
// asked the same way, since a disagreement between the two is what let a collision
// through in the first place.
//
// A socket FILE that no process is listening on answers false: dial fails with
// ECONNREFUSED, the jail is genuinely free, and the restore proceeds. That is not a
// tolerated edge case but the common one — a VM's Destroy removes its jail root, and a
// crashed VMM leaves the file behind with nothing behind it. Treating file existence as
// occupancy would refuse restores after any unclean exit.
func fcJailOccupied(path string) bool {
	conn, err := net.DialTimeout("unix", path, 200*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// Retry pacing for waitForUnixSocket (#304), and the RESOLUTION at which it can measure.
//
// It replaced a fixed 20 ms sleep, which was a measurement FLOOR: no restore could observe its
// socket sooner than one quantum, so min was 20.06 ms over 1,625 restores with zero below it
// (78.2% in [20,40), 21.8% in [40,60)).
//
// What removing that floor was worth is now measured, and it is much less than #304 predicted.
// On srv-r16b14s16 the mean went 24.92 -> 22.24 ms and the restore 27.73 -> 25.09 ms, about
// 11%. The earlier reasoning -- sockwait is 90% of a restore over 2.80 ms of real work, so the
// socket must appear in single-digit ms and we are merely sleeping past it -- was an INFERENCE
// the old data could not support: at 20 ms granularity "appears at 2 ms" and "appears at 19 ms"
// are the same reading. With fine polling the true distribution is visible and the socket
// genuinely takes ~10-40 ms to bind on this host, centred near 21 ms. The quantum happened to
// sit close to the real cost.
//
// So sockwait remains ~89% of a restore, and that residue is Firecracker's startup, which no
// poll change reaches. Do NOT read this constant block as having removed a throughput ceiling.
//
// RESIDUAL RESOLUTION, which bounds any attribution drawn from sockwait. The schedule from
// socketPollMin at socketPollGrowthNum/Den is:
//
//	attempt  1 dials at t=0        then sleeps 250us
//	attempt  5 dials at t=2.03ms   then sleeps 1.27ms
//	attempt  8 dials at t=8.04ms   then sleeps 4.27ms
//	attempt  9 dials at t=12.31ms  <- socketPollMax first applies here
//
// Eight sleeps total 12.31 ms, so the cap governs everything beyond that. At a 5 ms cap the
// measured p50 of ~21 ms therefore carried up to 5 ms of our own sleep -- and the "continuous"
// modes reported at [10,12), [14,16), [20,22), [26,28) were 4-6 ms apart because they WERE that
// comb, not a continuous distribution. The cap is 1 ms so the comb is finer than the thing being
// measured: sockwait is now accurate to about +-1 ms rather than +-5 ms, at ~27 probes to reach
// 25 ms. Raising it again re-inflates every sockwait figure by up to the new cap.
//
// Fine-and-growing rather than a flat fast poll: 250 us forever would spend three syscalls per
// attempt per concurrent restore for the whole wait, including the 5 s timeout path.
const (
	socketPollMin       = 250 * time.Microsecond
	socketPollMax       = 1 * time.Millisecond
	socketPollGrowthNum = 3
	socketPollGrowthDen = 2
)

// socketProbe is how waitForUnixSocket asks whether anything answers. A variable so a test can
// count attempts and thereby pin the backoff schedule itself -- wall-clock assertions cannot:
// with 1.5x growth the last sleep is at most ~0.5x the elapsed time, so total elapsed stays
// within ~1.5x the budget for ANY cap, and deleting the growth and cap outright left every test
// in socket_wait_unix_test.go green. Same reasoning as phaseLog being a var rather than a bool.
var socketProbe = func(path string) bool {
	conn, err := net.DialTimeout("unix", path, 100*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// socketSleep parks the poll loop for one interval, returning nil when the interval
// elapsed or the context's error if it ended the wait instead. A variable for the same
// reason socketProbe is: the pacing test pins the schedule by recording the intervals
// the loop ASKS to sleep, which no probe-count or wall-clock assertion can do on a
// shared CI runner -- there, time.Sleep overshoot is larger than the intervals being
// pinned (CI recorded 97 probes against a nominal ~197 with the schedule intact), so
// only the requested durations are deterministic.
var socketSleep = func(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// waitForUnixSocket returns once something ANSWERS at path, or on timeout/cancellation.
// File existence alone is not enough: Firecracker creates the socket file before it is
// actually accept()ing on it.
//
// It DIALS rather than stats, which is load-bearing in both directions for the FIRECRACKER
// sockets: a stat would report ready before accept() and race the snapshot PUT, and
// fcJailOccupied's id-collision guard rests on the same distinction, so a path that exists but
// answers nothing must not read as ready.
//
// That is NOT a universal property of this helper's callers, and the exception is load-bearing
// in the other direction. launcher_chv.go waits here on virtiofsd's vhost-user socket, and
// virtiofsdArgv starts it with no flag that survives a dropped connection -- in that mode the
// rust-vmm backend accepts exactly ONE connection and exits when it drops, so this probe's
// connect-and-close can consume the accept cloud-hypervisor then needs. That path predates this
// pacing change and finer polling does not alter how many connections are accepted, but it is
// recorded here so the dial-not-stat rule is not read as covering every caller. See the
// vhost-user disconnect launcher_chv.go already documents as unexplained and unfixed.
func waitForUnixSocket(ctx context.Context, path string, timeout time.Duration) error {
	return waitForUnixSocketObserved(ctx, path, timeout, nil)
}

// waitForUnixSocketObserved is waitForUnixSocket with a per-poll hook, used to split the
// pre-socket window at the jailed execve (#328, fcExecBoundary).
//
// One loop and one schedule, deliberately: the constant block above is the RESOLUTION at which
// anything inside this wait can be measured, so a second loop with its own pacing would make
// jailer_setup and fc_bind accurate to different quanta and their sum no longer sockwait. observe
// is nil on the production path, which leaves this exactly the old loop.
func waitForUnixSocketObserved(ctx context.Context, path string, timeout time.Duration, observe func()) error {
	deadline := time.Now().Add(timeout)
	wait := socketPollMin
	for {
		if observe != nil {
			observe()
		}
		if socketProbe(path) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out after %s waiting for %s", timeout, path)
		}
		if err := socketSleep(ctx, wait); err != nil {
			return err
		}
		// Grown after the sleep, so the FIRST retry is always the fine one -- that is the
		// case the measured distribution says matters, since every restore's socket appeared
		// inside the old single quantum.
		if wait < socketPollMax {
			if wait = wait * socketPollGrowthNum / socketPollGrowthDen; wait > socketPollMax {
				wait = socketPollMax
			}
		}
	}
}

// firecrackerVM is one restored, jailed VM.
type firecrackerVM struct {
	id, key string

	cmd      *exec.Cmd // the jailer process; execve's into FirecrackerBin, same pid
	jailRoot string
	// cgroups is the pool cgroupRel came from, and where Destroy returns it. Nil means there is
	// nothing pooled: either no ParentCgroup, or a VM built outside the launcher.
	cgroups *cgroupPool
	// cgroupRel is the slice-relative pooled cgroup this VM was placed in, returned on Destroy
	// rather than removed (#258).
	cgroupRel string

	apiSockHost   string
	vsockHostPath string
	vsockPort     uint32

	// egress and egressLn are set only when the launcher had egress on. egressLn owns the
	// <jail>/run/v.sock_<port> path (unlink-on-close); Reap unregisters and then closes it.
	egress   EgressBinder
	egressLn *net.UnixListener

	mu        sync.Mutex
	destroyed bool
	// killed latches the barrier half so the two entry points (Destroy, and
	// KillAndBarrier+Reap) cannot signal or re-time the same VMM twice.
	killed bool
	// The barrier half's timings, stashed so Reap can emit ONE phase line covering both
	// halves -- the fields are parsed by whatever aggregates a run, so splitting the line
	// would read as missing phases.
	phKill, phBarrier time.Duration
	barrierSeen       bool
	// Resume's three sub-phases, from the LAST Resume. Stashed rather than returned
	// because Resume's signature is the VM interface's, shared with a launcher this
	// decomposition does not apply to -- see resumePhaser in diag.go. Written by
	// Resume and read by ResumePhases, both under mu: Resume runs on the Exec's
	// goroutine while the deferred reaper may be touching this same VM's mu.
	phVMResume, phVsockDial, phMount time.Duration

	// The standby footprint (#644): this VM's pooled-cgroup memory.current, read
	// ONCE on the first StandbyBytes call and cached, error included — a failed
	// read pins the full-PerVMBytes charge rather than retrying a broken cgroup on
	// every admission check. All under mu. Paused VMs only: a VM that has Resumed
	// is inFlight and full-price, and nobody asks it again.
	standbyFootprint    int64
	standbyFootprintErr error
	standbyFootprintSet bool
}

// StandbyBytes implements standbyFootprinter (budget.go): this paused VM's
// dirty-page cost, from its pooled cgroup's memory.current.
//
// CACHED ON FIRST READ because the read is what admission control does per check
// and a paused VM's footprint is static: its vcpus are stopped, so nothing inside
// it can dirty another page between the read and the promotion that re-prices it
// at full PerVMBytes anyway. One cgroupfs syscall per standby per lifetime instead
// of one per admission.
func (v *firecrackerVM) StandbyBytes() (int64, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.standbyFootprintSet {
		return v.standbyFootprint, v.standbyFootprintErr
	}
	v.standbyFootprintSet = true
	if v.cgroups == nil || v.cgroupRel == "" {
		v.standbyFootprintErr = fmt.Errorf("firecracker VM %s: no pooled cgroup to read (ParentCgroup unset?)", v.id)
		return 0, v.standbyFootprintErr
	}
	v.standbyFootprint, v.standbyFootprintErr = readMemoryCurrent(v.cgroups.abs(v.cgroupRel))
	return v.standbyFootprint, v.standbyFootprintErr
}

// ResumePhases implements resumePhaser (diag.go). Zero until the first Resume.
func (v *firecrackerVM) ResumePhases() (vmResume, vsockDial, mount time.Duration) {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.phVMResume, v.phVsockDial, v.phMount
}

func (v *firecrackerVM) stashResumePhases(vmResume, vsockDial, mount time.Duration) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.phVMResume, v.phVsockDial, v.phMount = vmResume, vsockDial, mount
}

func (v *firecrackerVM) Key() string { return v.key }

// CgroupCPU implements cpuReporter (diag.go): the cumulative CPU of the pooled cgroup this VM
// was placed in. Cumulative across the cgroup's tenants (#258 reuses it), which is why ExecPhased
// takes a difference. Not measured when there is no pooled cgroup.
func (v *firecrackerVM) CgroupCPU() (user, sys time.Duration, ok bool) {
	if v.cgroups == nil || v.cgroupRel == "" {
		return 0, 0, false
	}
	return readCgroupCPU(v.cgroups.abs(v.cgroupRel))
}

// ID is the per-VM id that names the jail and the cgroup (read by vmID for the exec audit line).
func (v *firecrackerVM) ID() string { return v.id }

// Resume unpauses the VM and mounts the workspace over a fresh vsock connection —
// see launcher.go's VM.Resume doc comment, which is authoritative over this
// package's own design draft on where the mount happens: mount-at-acquire, not
// inside Run. Standbys restore UNMOUNTED because ext4 is not a shared-disk
// filesystem — two guest kernels mounting one rw image would corrupt it, and a
// standby that stayed mounted across restores would do exactly that with zero
// concurrent Execs. Mounting fresh on every acquire is also correct rather than
// merely necessary: it re-reads the device's metadata, retiring the stale-metadata
// hazard a pre-mounted standby would carry (spec §4.3).
func (v *firecrackerVM) Resume(ctx context.Context) error {
	// Sub-phase timing for resumePhaser. time.Now(), not a Clock, for the reason the
	// runOverConn call below already documents: VM implementations have none injected.
	// Every stamp is recorded even on a failure path -- a Resume that failed IN one of
	// these steps is when knowing which one matters most -- so each assignment happens
	// before the error check, and stashResumePhases runs via defer.
	//
	// REGISTERED BEFORE THE FIRST RETURN, INCLUDING checkNotDestroyed's. Below the guard
	// it was skipped on that path, which left the previous values in place -- so
	// resumePhaser's "a failed Resume overwrites the previous one's values" had an
	// exception, and a caller reading the stash after a refused Resume (pool.go does,
	// unconditionally, on the error path) saw another attempt's real measurements rather
	// than zeros. Entry now always resets the stash, so that invariant holds with no
	// exception. TestFirecrackerResumeResetsPhasesOnRefusal pins it: that guard returns
	// before any Firecracker contact, so unlike the stamps below it IS unit-testable.
	//
	// THE MOUNT IS STAMPED IN THIS SAME CLOSURE, ON PURPOSE. It used to have a defer of
	// its own, registered later, and was therefore correct only by LIFO: regroup the two
	// defers -- which reads as tidier -- and mount_us reports 0 forever while resume_us
	// keeps reporting normally, on the term that is 78-81% of the phase. One closure
	// leaves no order to get wrong. mountStart stays zero until the mount is actually
	// reached, which is what preserves the documented partial-failure shape: a Resume
	// that fails earlier reports zero for the steps it never entered (see resumePhaser
	// in diag.go), rather than a duration measured from an unset clock.
	//
	// ONE IMPRECISION, ACCEPTED DELIBERATELY: because phMount closes in the closure, it
	// runs to Resume's RETURN, so it also covers the two checks after runOverConn (the
	// error and the exit code) -- two comparisons against a 19.2 ms measurement. Capturing
	// a mountEnd after them would make the stamp exact, and moving the stamp out of the
	// closure would too, but the latter reinstates the LIFO hazard above; that trade is the
	// wrong way round, so the boundary is documented instead of moved.
	var phVMResume, phVsockDial, phMount time.Duration
	var mountStart time.Time
	defer func() {
		if !mountStart.IsZero() {
			phMount = time.Since(mountStart)
		}
		v.stashResumePhases(phVMResume, phVsockDial, phMount)
	}()

	if err := v.checkNotDestroyed(); err != nil {
		return err
	}

	fc := newFCClient(v.apiSockHost)
	// The clock starts BELOW newFCClient so phVMResume is the PATCH alone, which is what
	// Phases.VMResume documents it as. newFCClient only allocates (fcapi.go) so this is a
	// sub-microsecond correction against a 361 us measurement, but the stamp should mean
	// what its comment says.
	phaseStart := time.Now()
	resumeErr := fc.Resume(ctx)
	phVMResume = time.Since(phaseStart)
	if resumeErr != nil {
		return fmt.Errorf("firecracker: resume %s: %w", v.id, resumeErr)
	}

	dialStart := time.Now()
	conn, err := dialVsock(v.vsockHostPath, v.vsockPort)
	phVsockDial = time.Since(dialStart)
	if err != nil {
		return fmt.Errorf("firecracker: resume %s: dial vsock: %w", v.id, err)
	}
	mountStart = time.Now()
	// runOverConn closes conn itself (guestconn.go), and this is a FRESH connection
	// used for exactly this one internal command — never reused by Run, which dials
	// its own (see runOverConn's doc comment on why: established connections are
	// closed on resume, so a connection carried across a snapshot boundary would be a
	// connection to nowhere, and by the same logic one connection cannot straddle
	// "the mount" and "the user's command" either without risking exactly that if a
	// future resume ever intervened between them).
	//
	// time.Now() here (not a Clock): VM implementations have no injected Clock —
	// only pool.go, one layer up, threads one through — so this is the one place in
	// the call chain that must read the wall clock directly. This IS coordinator
	// finding #6's wall-clock correction: sendRequest (guestconn.go) puts it in the
	// Request frame as HostUnixNanos, which the guest agent uses to correct its own
	// clock after resume — Resume needs no separate step for that.
	res, err := runOverConn(ctx, conn, Command{
		Command:  "mountpoint -q /workspace || mount -o rw,noatime /dev/vdb /workspace",
		TimeoutS: 30,
		CapBytes: OutputCapBytes,
	}, discardingSink{}, time.Now())
	if err != nil {
		return fmt.Errorf("firecracker: resume %s: mount /workspace: %w", v.id, err)
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("firecracker: resume %s: mount /workspace exited %d", v.id, res.ExitCode)
	}
	return nil
}

// wrapCommand is Run's one mandatory addition: sync before the VM dies. (The other
// candidate addition, mounting /workspace, already happened in Resume — see its
// doc comment — so this does NOT repeat a mount here; an earlier draft of this
// launcher did, and that was wrong for the reason Resume's comment explains.)
//
// SYNC BEFORE THE VM DIES. The guest page cache dies with the VM, so without this a
// write in Exec N is simply absent in Exec N+1 — spec §8's write-durability gate is
// what catches its omission. `(exit $__fc_rc)` preserves the command's own exit
// status: sync must not be able to change what the worker reports.
//
// The command runs in a SUBSHELL, not a brace group, so that its own `exit` ends the
// subshell instead of this whole script — a brace group let a command ending in
// `exit` (every writeFileCommand-based put does; packages/sandbox-client's put/edit
// scripts end `exit 0`/`exit 1`) skip the sync and take its writes to the grave with
// the VM's page cache. The guest agent's parked-shell path sources this same script
// inside its own `( . file )` subshell, so the subshell here is what makes `exit`
// survivable on BOTH paths.
func wrapCommand(cmd string) string {
	return "cd /workspace\n( " + cmd + "\n)\n__fc_rc=$?\nsync\n(exit $__fc_rc)\n"
}

// Run sends exactly one command over a fresh vsock connection. Dialed AFTER resume,
// never before: established connections are closed on resume (spec §2.4), and this
// is always called after Resume has already succeeded (pool.go's ExecPhased order).
func (v *firecrackerVM) Run(ctx context.Context, c Command, out Sink) (Result, error) {
	if err := v.checkNotDestroyed(); err != nil {
		return Result{}, err
	}

	conn, err := dialVsock(v.vsockHostPath, v.vsockPort)
	if err != nil {
		return Result{}, fmt.Errorf("firecracker: run %s: dial vsock: %w", v.id, err)
	}
	wrapped := c
	wrapped.Command = wrapCommand(c.Command)
	// runOverConn is THE protocol implementation (guestconn.go) — reused here rather
	// than re-implemented, per this task's constraint that there must be exactly one.
	return runOverConn(ctx, conn, wrapped, out, time.Now())
}

// Destroy SIGKILLs the jailer's (and, by the same pid, Firecracker's) process
// group, reaps it, and removes the jail directory. Idempotent: spec §6 requires
// abort-after-teardown not to error, and pool.go's destroy calls this exactly once
// per VM but a caller-side bug retrying it must not become a second failure mode.
// A failure here is logged and counted by pool.go's destroy, never returned up the
// Exec path — it does not change what the command already did.
// Destroy is the whole teardown, synchronously: the barrier half then the reap half. It is
// what every caller outside the hot path uses -- Close, the reclaim goroutine, replenishOne's
// post-warm branch, DestroyAllStandbys -- and its contract is unchanged. Idempotent: spec §6
// requires abort-after-teardown not to error, and pool.go calls this exactly once per VM but a
// caller-side bug retrying it must not become a second failure mode. A failure is logged and
// counted by pool.go's destroy, never returned up the Exec path -- it does not change what the
// command already did.
//
// It does NOT wait for the barrier, because the gate is held across the whole thing here
// anyway: paying for an observation nobody acts on would be a regression in the arm that has
// the deferral switched off, and that arm has to be exactly as it was for the A/B to mean
// anything.
func (v *firecrackerVM) Destroy() error {
	return errors.Join(v.kill(false), v.Reap())
}

// KillAndBarrier is deferredReaper's first half: SIGKILL the jailer's (and by the same pid,
// Firecracker's) process group, then block until that process holds no file descriptor.
//
// An error here means the barrier could not be OBSERVED, and pool.destroy answers it by
// reaping synchronously under the gate -- the old ordering. Nothing about this call is
// best-effort: it is the licence for opening the gate early, so "I could not check" must be
// distinguishable from "checked, and it is safe".
func (v *firecrackerVM) KillAndBarrier() error { return v.kill(true) }

// kill signals the VMM and, when waitForBarrier, waits for its descriptors to close.
//
// WHY THE DESCRIPTORS ARE THE RIGHT BARRIER (#307). execGate exists because "a second guest
// mounting [the ext4 workspace] rw while the first still holds it would corrupt it". The mount
// is the GUEST's -- Resume issues `mount -o rw,noatime /dev/vdb /workspace` over vsock -- so
// the invariant is that at most one live guest holds the image. `kill` alone does not establish
// it: kill(2) only queues the signal, and a thread inside an uninterruptible pwrite completes
// it first. An empty /proc/<pid>/fd does establish it, and directly rather than by inference:
// a process with no descriptor cannot write to workspace.img. exit_files drops every f_count
// before the expensive __fput work runs, which is why it lands early -- median 1.41 ms against
// a 52.88 ms reap at c=64, 0 of 1216 samples unobserved and 0 later than the reap.
//
// The measurement also rejected the alternative. /proc/<pid>/status Threads: reaching 1 sounds
// sufficient (no vCPU or device thread left to issue a write) but under load it had 12
// unobserved samples and a 65 ms maximum: the thread group sometimes does not empty before the
// leader is reaped.
//
// NO PROCESS IS A SATISFIED BARRIER, not a failed one. There is nothing that could write.
func (v *firecrackerVM) kill(waitForBarrier bool) error {
	v.mu.Lock()
	if v.destroyed || v.killed {
		v.mu.Unlock()
		return nil
	}
	v.killed = true
	cmd := v.cmd
	v.mu.Unlock()

	if cmd == nil || cmd.Process == nil {
		return nil
	}
	var errs []error
	pid := cmd.Process.Pid
	killStart := time.Now()
	if err := fcKillProcessGroup(pid); err != nil && !fcProcessNotFound(err) {
		errs = append(errs, fmt.Errorf("kill -%d: %w", pid, err))
	}
	phKill := time.Since(killStart)
	var phBarrier time.Duration
	seen := false
	if waitForBarrier {
		phBarrier, seen = fcWaitFDsGone(pid, fcBarrierTimeout)
		if !seen {
			errs = append(errs, fmt.Errorf("barrier for %d: /proc/%d/fd did not empty within %v",
				pid, pid, fcBarrierTimeout))
		}
	}
	v.mu.Lock()
	v.phKill, v.phBarrier, v.barrierSeen = phKill, phBarrier, seen
	v.mu.Unlock()
	return errors.Join(errs...)
}

// Reap is deferredReaper's second half and the rest of the teardown: cmd.Wait, the jail unlink,
// then the cgroup release, in that order and unchanged from when they ran inside Destroy. Safe
// on any goroutine, and safe to call without KillAndBarrier (Destroy does exactly that).
//
// The ORDER inside here is load-bearing and is why the tail is deferred as a unit rather than
// piecemeal: RemoveAll unlinks the jail, which holds a hardlink to workspace.img, and
// cgroups.release reads cgroup.procs to decide whether reuse is safe. Both must follow the
// reap, exactly as before.
func (v *firecrackerVM) Reap() error {
	v.mu.Lock()
	if v.destroyed {
		v.mu.Unlock()
		return nil
	}
	v.destroyed = true
	cmd := v.cmd
	phKill, phBarrier, barrierSeen := v.phKill, v.phBarrier, v.barrierSeen
	v.mu.Unlock()

	var errs []error
	// Sub-phase timing (#258 Task 3.1). Destroy is the largest phase of an Exec and was the
	// only one with no internal visibility. Behind SH_DIAG_PHASES like the restore phases: the
	// time.Now() calls are ~100ns against a Destroy measured in tens of MILLISECONDS, so they
	// are unconditional and only the log line is gated.
	//
	// Measured with time.Since rather than a running clock so each step is independent: they
	// are reported separately precisely because the expectation is that ONE of them dominates,
	// and a running total cannot show which.
	var phWait, phDrain, phRemoveAll, phCgroupWait, phCgroupRmdir time.Duration
	// Declared out here so the phase line can report them as UNOBSERVED (-1) on the path where
	// there was no process to watch at all.
	var fdGone, threadsGone time.Duration
	var fdSeen, threadsSeen bool
	phaseStart := time.Now()
	if cmd != nil && cmd.Process != nil {
		waitStart := time.Now()
		// Started from the same instant wait_us is measured from, so the two are directly
		// comparable. No-ops unless SH_DIAG_PHASES=1. When KillAndBarrier already waited for
		// the descriptors, fdgone_us here reads ~0, which is correct: they were already gone.
		obs, stopObs := startFCExitObserver(cmd.Process.Pid, waitStart)
		if phaseLog == nil {
			_ = cmd.Wait() // reap; "signal: killed" is the expected outcome, not a failure
			phWait = time.Since(waitStart)
		} else {
			// #334's diagnostic split. cmd.Wait() is TWO waits, not one: os/exec's Wait calls
			// Process.Wait() (the wait4 that reaps the VMM) and only then awaitGoroutines(),
			// which blocks until the stdout/stderr copying goroutines return. Those goroutines
			// exist because Restore sets Stdout/Stderr to io.Discard, and writerDescriptor takes
			// the pipe branch for any writer that is not an *os.File -- so every VM allocates two
			// os.Pipe()s and two goroutines, and this phase pays to drain them.
			//
			// Timing the halves apart is the whole point: "cmd.Wait is 89% of Destroy" is
			// consistent with the kernel being slow to tear down a 256 MiB mapping AND with this
			// process being slow to schedule two goroutines under load, and those have opposite
			// fixes. It answered 0.006-0.055 ms, i.e. 0.016-0.097% of Destroy. Split only under
			// diagnostics so the production path keeps the single Wait and its error semantics.
			//
			// The second call's Process.Wait() fails fast with ECHILD -- the process was
			// already reaped just above, so there is no child left to wait for. Cmd.Wait does
			// NOT return early on that error: it assigns c.ProcessState and falls through to
			// awaitGoroutines regardless. So phDrain is the goroutine drain, not a second reap.
			//
			// One invariant this creates, stated because it holds only on this branch: because
			// Cmd.ProcessState is assigned from the FAILED second Process.Wait(), it is left
			// nil here, where the production path above leaves it set. Harmless today -- both
			// results are discarded and nothing downstream of Destroy reads it -- but an
			// exit-code check added inside this branch would see a nil that cannot be
			// reproduced in production.
			//
			// Verified against go1.25.0, the toolchain these numbers were measured with:
			// errors.Is(err, syscall.ECHILD) is true and errors.Is(err, os.ErrProcessDone) is
			// false. ErrProcessDone is what Signal returns on a finished process, not what
			// Wait returns on a second call.
			_, _ = cmd.Process.Wait()
			phWait = time.Since(waitStart)
			drainStart := time.Now()
			_ = cmd.Wait()
			phDrain = time.Since(drainStart)
		}
		stopObs()
		fdGone, threadsGone, fdSeen, threadsSeen = obs.results()
	}
	// SIGKILL (already sent) -> Unregister -> unlink (P4.1 §6). Unregistering only after the VMM is
	// reaped means no live guest can still be mid-connect against a registration being torn down;
	// closing the listener (which unlinks the path) only after Unregister means moca-egress never
	// holds a descriptor for a path that has vanished first. An Unregister failure is logged, not
	// counted as a destroy failure: it is harmless (moca-egress unbinds everything a lost control
	// connection owned, and the client never replays a VM it has forgotten), and it must not skip
	// the unlink or the jail removal below.
	if v.egressLn != nil {
		if v.egress != nil {
			uctx, ucancel := context.WithTimeout(context.Background(), egressControlTimeout)
			if err := v.egress.Unregister(uctx, v.id); err != nil {
				log.Printf("vmpool: egress unregister %s during destroy: %v", v.id, err)
			}
			ucancel()
		}
		_ = v.egressLn.Close()
	}
	// #307 Q4: removeall grows 5.92 -> 22.72 ms across the slot sweep, and it is the only step
	// in Destroy where a storage-layer answer could apply -- but only for bytes that this unlink
	// actually frees. Six of the jail's entries are hardlinks to the golden snapshot and to the
	// run's workspace image, so unlinking them drops a refcount and frees nothing; the jailer's
	// own copy of the exec-file is the one entry whose blocks are released here. Inventory it
	// before removal rather than reasoning about it, so the thin-provisioning conversation starts
	// from a number. Diagnostics only: this is a stat walk per VM.
	if phaseLog != nil {
		inv := jailInventory(v.jailRoot)
		phaseLog("vmpool: destroy jail id=%s entries=%d dirs=%d linked=%d linked_bytes=%d linked_blocks512=%d owned=%d owned_bytes=%d owned_blocks512=%d",
			v.id, inv.entries, inv.dirs, inv.linked, inv.linkedBytes, inv.linkedBlocks512,
			inv.owned, inv.ownedBytes, inv.ownedBlocks512)
	}
	removeAllStart := time.Now()
	if err := os.RemoveAll(v.jailRoot); err != nil {
		errs = append(errs, fmt.Errorf("remove jail %s: %w", v.jailRoot, err))
	}
	phRemoveAll = time.Since(removeAllStart)
	// Issue #255. Until this existed, the per-VM cgroup was removed only by SweepOrphans,
	// which runs at STARTUP -- so one directory leaked per Exec for the whole life of the
	// worker process and only a restart reclaimed them. That is not hygiene: cgroup
	// create/destroy is kernel-serialised and degrades with how many exist, so a jailer
	// cgroup that is slow to set up delays Firecracker binding its API socket, the cost
	// lands in waitForUnixSocket (~90% of a restore, #304), and restores are how the
	// standby pool replenishes. Measured at ~41,000 stale directories on one 16-slot
	// worker: 25.84 Exec/s and a 1008 ms mean sockwait, against 136.51 and 98 ms with the
	// directories removed and nothing else changed -- 5.3x.
	//
	// rmdir, never rm -rf (D5): cgroup directories are kernel-backed pseudo-files.
	// removeCgroupDir is the same helper SweepOrphans uses, so the two paths cannot
	// disagree about what removal means.
	//
	// The VMM was SIGKILLed and reaped above, so the kernel has already emptied
	// cgroup.procs; waitForCgroupEmpty is a short bounded guard for the case where it has
	// not yet, not an expected wait. A failure here is reported like the others -- the
	// caller logs it and counts destroyFailed rather than failing the Exec, which is the
	// right weight: a leaked directory must be visible, and must not break a command that
	// already ran correctly.
	if v.cgroupRel != "" && v.cgroups != nil {
		// RETURNED to the pool, not removed (#258). This is where the rmdir used to be, and where
		// it measured 2.15 / 15.53 / 195.52 ms at 4 / 16 / 64 concurrency slots -- 77% of Destroy
		// at the top, because cgroup removal is kernel-serialised.
		//
		// waitForCgroupEmpty still runs first because release() reads cgroup.procs to decide
		// whether reuse is safe, and cmd.Wait above should already have emptied it -- measured at
		// 0.04-0.07 ms, i.e. it never fires. The phase names are kept so a run's aggregate tooling
		// is unchanged: cgroupwait_us still means the same thing, and cgrouprmdir_us now measures
		// the RELEASE, which is expected to be ~0 because it is a slice append.
		cgWaitStart := time.Now()
		waitForCgroupEmpty(v.cgroups.abs(v.cgroupRel))
		phCgroupWait = time.Since(cgWaitStart)
		cgRelStart := time.Now()
		v.cgroups.release(v.cgroupRel)
		phCgroupRmdir = time.Since(cgRelStart)
	}
	if phaseLog != nil {
		phaseLog("vmpool: destroy phases id=%s kill_us=%d barrier_us=%d wait_us=%d fdgone_us=%d "+
			"drain_us=%d threadsgone_us=%d removeall_us=%d cgroupwait_us=%d cgrouprmdir_us=%d total_us=%d",
			v.id, phKill.Microseconds(), barrierUs(phBarrier, barrierSeen), phWait.Microseconds(),
			barrierUs(fdGone, fdSeen), phDrain.Microseconds(), barrierUs(threadsGone, threadsSeen),
			phRemoveAll.Microseconds(),
			phCgroupWait.Microseconds(), phCgroupRmdir.Microseconds(),
			// total_us still means THE WHOLE TEARDOWN, both halves, so it reconciles against
			// its parts and stays comparable with every table recorded before the split. Taking
			// time.Since(phaseStart) alone would silently redefine it as the tail only -- a
			// renamed field by stealth, which reads as a phase that got faster.
			(phKill + phBarrier + time.Since(phaseStart)).Microseconds())
	}
	return errors.Join(errs...)
}

func (v *firecrackerVM) checkNotDestroyed() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.destroyed {
		return fmt.Errorf("firecracker: VM %s: used after Destroy", v.id)
	}
	return nil
}
