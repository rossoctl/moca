// Command microvm-worker serves the SAME Attach wire contract as remote-worker, but
// runs every Exec in a microVM created for it and destroyed after it.
//
// It is a SIBLING of cmd/worker, not a replacement: remote-worker is untouched, which
// is what makes "the container arm cannot regress" a structural fact rather than a
// test result, and what makes E11's A/B an image swap (spec §10).
//
// PRIVILEGE. Unlike remote-worker this process needs /dev/kvm and the right to spawn
// VMMs. That is acceptable only because nothing agent-influenced ever executes outside
// a VM: this process parses a frame, writes bytes to a vsock, and spawns a VMM with
// fixed argv (spec §3.5). There is deliberately no host-execution fallback — see
// launcherFor.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	"github.com/rossoctl/moca/remote-worker/internal/session"
	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

const (
	backoffMin = 500 * time.Millisecond
	backoffMax = 30 * time.Second
)

func env(get func(string) string, k, def string) string {
	if v := get(k); v != "" {
		return v
	}
	return def
}

func envInt64(get func(string) string, k string, def int64) (int64, error) {
	v := get(k)
	if v == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s=%q must be a positive integer", k, v)
	}
	return n, nil
}

// microvmDefaultConcurrency is THIS TIER's default concurrency-slot count, deliberately not
// session.DefaultConcurrency (4).
//
// MaxConcurrent sizes a fixed pool of goroutines, one per slot, so a worker left at 4 serves
// 4 Execs at once however many are dispatched -- and e11-density.sh never set it, so every
// microVM rung ever recorded measured a 4-slot cap while its ladder swept concurrency to 64
// (issue #305).
//
// Why the default belongs PER TIER rather than in the shared constant: the per-slot cost that
// makes slots expensive is 2 x exec.BufferCap (8 MiB) of stream buffer, and it is the
// container worker that pays it against a hard pod limit. worker-deployment.yaml allows 256Mi
// for 4 slots' 64 MiB worst case; at 16 slots that worst case IS 256 MiB, which would restore
// exactly the OOMKill-a-relay-can-trigger the manifest records fixing. This tier has no pod
// limit, its memory is gated by the mandatory SH_MAX_COMMITTED_MB over 256 MiB guests, and
// 256 MiB of worst-case buffers is negligible beside that budget.
//
// Why 16 and not higher: 16 is the largest slot count actually measured -- 172.88 Exec/s
// against 62.99 at 4 slots on the same 72-core host, 2.74x. Beyond it is extrapolation, and
// where slots stop paying is its own sweep. The default must not wander past the evidence.
const microvmDefaultConcurrency = 16

// slotBudgetWarning returns a warning when the slot count can commit more VM memory than
// the admission budget allows, or "" when it fits.
//
// Raising this tier's default from 4 to 16 multiplies VM commitment, not just the
// 2 x exec.BufferCap of stream buffer the default's rationale reasons about.
// committedLocked sums ready+inFlight+warming across run pools and StandbyDepth is per RUN
// KEY, so N slots carrying distinct workspace_keys commit up to N x (1 + D) VMs: 48 at 16
// slots and the shipped D=2, ~13.5 GiB at a 256 MiB guest, against 12 VMs / ~3.4 GiB at 4.
//
// Overflow does not arrive as back-pressure. admitLocked returns RefuseMemoryBudget, and
// budget.go records that there is no "busy" frame on the wire, so a refusal "reaches the
// harness as a failed exec". An operator who sized SH_MAX_COMMITTED_MB for 4 slots by
// following METAL-RUNBOOK's "size it to this host" would now see hard exec errors under
// concurrency, with nothing at startup having said why.
//
// WARNS rather than refusing, deliberately. The N x (1 + D) figure is a WORST CASE that
// needs N distinct workspace keys; a single session holds one key and commits 1 x (1 + D)
// however many slots exist. Failing the unit would stop deployments that work today and
// whose worst case never materialises. The runtime gate still refuses, so the risk is
// degraded service rather than silent corruption -- but the operator is told at startup,
// which is the whole point of #305: a slot count nobody chose must not be invisible.
func slotBudgetWarning(cfg vmpool.Config, maxConcurrent int) string {
	// Normalize a COPY: it is what fills VMOverheadBytes, and it runs inside vmpool.New on
	// New's own copy, so main's cfg can still carry a zero here and PerVMBytes would
	// understate the commitment.
	c := cfg
	if err := c.Normalize(); err != nil {
		return ""
	}
	budget := c.MaxCommittedBytes - c.MemoryReserveBytes
	if budget <= 0 {
		return ""
	}
	worst := int64(maxConcurrent) * int64(1+c.StandbyDepth) * vmpool.PerVMBytes(c)
	if worst <= budget {
		return ""
	}
	return fmt.Sprintf(
		"WARNING: %d concurrency slots at D=%d can commit %d VMs (%d MiB) but the admission budget is %d MiB "+
			"(SH_MAX_COMMITTED_MB minus SH_MEMORY_RESERVE_MB). That worst case needs %d distinct workspace keys; "+
			"reaching it returns RefuseMemoryBudget, which arrives at the harness as a FAILED EXEC rather than as "+
			"back-pressure. Raise SH_MAX_COMMITTED_MB or lower WORKER_MAX_CONCURRENT.",
		maxConcurrent, c.StandbyDepth, int64(maxConcurrent)*int64(1+c.StandbyDepth),
		worst>>20, budget>>20, maxConcurrent)
}

// workerMaxConcurrent resolves the worker's concurrency-slot count.
//
// It REFUSES a malformed WORKER_MAX_CONCURRENT rather than falling back to the default. The
// inline form this replaced discarded the error --
// `if v, e := envInt64(...); e == nil { maxConcurrent = int(v) }` -- so a typo ran silently at
// the default slot count, which is the single number that set every throughput figure this
// project has published. A run whose slots came from a typo must not look like a run that
// chose them.
func workerMaxConcurrent(get func(string) string) (int, error) {
	v, err := envInt64(get, "WORKER_MAX_CONCURRENT", int64(microvmDefaultConcurrency))
	if err != nil {
		return 0, err
	}
	return int(v), nil
}

// poolConfig reads vmpool.Config from the environment and refuses rather than
// guessing. Every required value below is one whose wrong default is a security or
// capacity bug, so there is no "sensible default" to fall back on: spec §6's posture
// is "fail the unit at start", not "degrade".
func poolConfig(get func(string) string) (vmpool.Config, error) {
	var cfg vmpool.Config
	cfg.VMM = vmpool.VMMKind(env(get, "SH_VMM", string(vmpool.Firecracker)))
	cfg.SnapshotDir = get("SH_SNAPSHOT_DIR")
	if cfg.SnapshotDir == "" {
		return cfg, fmt.Errorf("SH_SNAPSHOT_DIR is required")
	}
	cfg.WorkspaceRoot = get("SH_WORKSPACE_ROOT")
	if cfg.WorkspaceRoot == "" {
		return cfg, fmt.Errorf("SH_WORKSPACE_ROOT is required")
	}
	if get("SH_MAX_COMMITTED_MB") == "" {
		return cfg, fmt.Errorf("SH_MAX_COMMITTED_MB is required: without the memory gate, " +
			"pressure goes straight to the OOM killer, whose size-ranked favourites include " +
			"this process and every run on the host (spec §6)")
	}
	var err error
	if v, e := envInt64(get, "SH_STANDBY_DEPTH", vmpool.DefaultStandbyDepth); e != nil {
		err = e
	} else {
		cfg.StandbyDepth = int(v)
	}
	if v, e := envInt64(get, "SH_GUEST_RAM_MB", vmpool.DefaultGuestRAMBytes>>20); e != nil && err == nil {
		err = e
	} else if e == nil {
		cfg.GuestRAMBytes = v << 20
	}
	if v, e := envInt64(get, "SH_MAX_RUNS", 64); e != nil && err == nil {
		err = e
	} else if e == nil {
		cfg.MaxRuns = int(v)
	}
	if v, e := envInt64(get, "SH_MAX_COMMITTED_MB", 0); e != nil && err == nil {
		err = e
	} else if e == nil {
		cfg.MaxCommittedBytes = v << 20
	}
	if get("SH_MEMORY_RESERVE_MB") != "" {
		if v, e := envInt64(get, "SH_MEMORY_RESERVE_MB", 0); e != nil && err == nil {
			err = e
		} else if e == nil {
			cfg.MemoryReserveBytes = v << 20
		}
	}
	return cfg, err
}

// launcherFor maps a VMMKind to a Launcher.
//
// NO HOST-EXECUTION FALLBACK, deliberately and permanently. vmpool.FakeLauncher runs
// commands with host bash and is reachable only from vmpoolctl; wiring it here would
// put agent-authored code inside the privileged process, which is strictly worse than
// today's container (spec §3.3, §3.5). Spec §6's "KVM unavailable at startup" row
// says fail the unit at start — and the strongest form of that is having no code path
// that could do otherwise. §8's "nothing executes outside a VM" gate pins it.
//
// get and snapDir are threaded through (rather than read from the environment
// inline) so this function stays a pure mapping from already-resolved config to a
// Launcher — the same shape poolConfig above already uses. perVMBytes is
// vmpool.PerVMBytes(cfg) (Task 17, hardware-corrections D1): the SAME figure
// admission control charges per VM, threaded into both arms' CgroupMemoryMaxBytes
// below so jailer's --cgroup memory.max= (Firecracker) and systemd-run --scope's
// -p MemoryMax= (Cloud Hypervisor) can never drift from a second, independently
// maintained constant — there must be exactly one number, computed once in main(),
// not re-derived per arm.
func launcherFor(kind vmpool.VMMKind, get func(string) string, snapDir string, perVMBytes int64) (vmpool.Launcher, error) {
	switch kind {
	case vmpool.Firecracker, vmpool.CloudHypervisor:
		// Fix round 9: the actual Firecracker/CloudHypervisor option construction
		// used to be hand-rolled here AND, separately, in cmd/vmpoolctl/main.go's
		// launcher() — two copies that already drifted once (round 3's CloudHypervisor
		// fix landed here but not there). vmpool.LauncherFromEnv is now the one place
		// that builds either arm's options; this function's own job shrinks to what
		// only it should decide — that "fake" and anything else are refused, so
		// microvm-worker structurally has no host-execution fallback (spec §3.5), the
		// one thing this file must NOT delegate to a helper vmpoolctl also calls.
		//
		// "microvm-worker" (last argument) is CloudHypervisor's chvRunDirName, not a
		// path: fix round 10 stopped hardcoding a fixed /run/... RunDir default in
		// favor of a same-device sibling of snapshotDir (chvDefaultRunDir, in
		// launcher_env.go — see its doc comment and LauncherFromEnv's CloudHypervisor
		// case for why /run could never actually work here once Restore started
		// hardlinking snapshot files into it). This name only has to differ from
		// vmpoolctl's own ("vmpoolctl") so the two never derive the identical default
		// directory when pointed at the same snapshotDir.
		return vmpool.LauncherFromEnv(kind, get, snapDir, perVMBytes, "microvm-worker")
	default:
		return nil, fmt.Errorf("SH_VMM=%q must be %q or %q; there is no host-execution fallback (spec §3.5)",
			kind, vmpool.Firecracker, vmpool.CloudHypervisor)
	}
}

// --- Item 5 (fix round): verify the manifest's recorded InstanceType against the
// running host. This is ADDITIVE to the existing verify+pin+probe block in main():
// man.Verify above only checks the snapshot's own internal hashes, never the host
// it is about to be restored onto, and spec §2.4 requires identical hardware for a
// restore to be safe at all (device/BAR/CPU-feature assumptions baked into the
// paused VM state). None of vmpool's existing exported API is touched.

// instanceTypeCheckOverrideEnv opts a host OUT of this check for deliberate
// cross-host use (e.g. local dev, or a documented compatible substitute type). Off
// by default: silence here would mean every worker on the fleet restoring onto the
// wrong hardware and finding out only when a guest first misbehaves.
const instanceTypeCheckOverrideEnv = "SH_ALLOW_INSTANCE_TYPE_MISMATCH"

// metadataTimeout bounds each individual cloud metadata probe. These services only
// answer on the host's own link-local address and either respond in single-digit
// milliseconds or not at all (wrong cloud, or no metadata service present) --
// generous enough to tolerate a slow VM, short enough that probing three clouds in
// turn on a bare-metal box costs a human-imperceptible fraction of a second.
const metadataTimeout = 300 * time.Millisecond

// detectHostInstanceType identifies the machine microvm-worker is running on, in
// the same vocabulary build-snapshot.sh's manifest records for instance_type.
//
// Fix-round-2 item C: build-snapshot.sh's detect_host_instance_type (deploy/
// microvm/build-snapshot.sh) auto-detects the build host using THIS EXACT
// precedence -- EC2 IMDSv2, then GCP metadata, then Azure IMDS, then DMI
// product_name -- and only lets --instance-type override that when explicitly
// passed. That pairing is deliberate: if you change the order (or add/remove a
// probe) here, change it there too, or a manifest and the worker verifying it
// will silently drift onto different hardware identities again.
//
// It tries each cloud provider's metadata service in turn -- generalized beyond EC2
// deliberately, since nothing here should assume the fleet is EC2-only -- and falls
// back to a stable, non-cloud host identity when none answer, so bare-metal and
// other-hypervisor hosts still get a real check instead of none.
func detectHostInstanceType(ctx context.Context) string {
	if t := ec2InstanceType(ctx); t != "" {
		return t
	}
	if t := gcpMachineType(ctx); t != "" {
		return t
	}
	if t := azureVMSize(ctx); t != "" {
		return t
	}
	return stableHostIdentity()
}

func metadataGET(ctx context.Context, url string, headers map[string]string) string {
	ctx, cancel := context.WithTimeout(ctx, metadataTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return ""
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(body))
}

// ec2InstanceType speaks IMDSv2: a token must be minted (PUT /latest/api/token)
// before EC2's metadata service will answer any meta-data GET.
func ec2InstanceType(ctx context.Context) string {
	tctx, cancel := context.WithTimeout(ctx, metadataTimeout)
	defer cancel()
	treq, err := http.NewRequestWithContext(tctx, http.MethodPut, "http://169.254.169.254/latest/api/token", nil)
	if err != nil {
		return ""
	}
	treq.Header.Set("X-aws-ec2-metadata-token-ttl-seconds", "60")
	tresp, err := http.DefaultClient.Do(treq)
	if err != nil {
		return ""
	}
	defer func() { _ = tresp.Body.Close() }()
	if tresp.StatusCode != http.StatusOK {
		return ""
	}
	tokBytes, err := io.ReadAll(io.LimitReader(tresp.Body, 256))
	if err != nil {
		return ""
	}
	token := strings.TrimSpace(string(tokBytes))
	return metadataGET(ctx, "http://169.254.169.254/latest/meta-data/instance-type",
		map[string]string{"X-aws-ec2-metadata-token": token})
}

// gcpMachineType asks GCE's metadata server, which answers any request carrying the
// Metadata-Flavor header without further auth.
func gcpMachineType(ctx context.Context) string {
	raw := metadataGET(ctx, "http://metadata.google.internal/computeMetadata/v1/instance/machine-type",
		map[string]string{"Metadata-Flavor": "Google"})
	// GCE returns "projects/<num>/machineTypes/<type>"; take the trailing segment so
	// this is comparable to what build-snapshot.sh recorded.
	if idx := strings.LastIndex(raw, "/"); idx >= 0 {
		return raw[idx+1:]
	}
	return raw
}

// azureVMSize asks Azure IMDS, which (like GCE) answers any request carrying its
// required header without further auth.
func azureVMSize(ctx context.Context) string {
	return metadataGET(ctx,
		"http://169.254.169.254/metadata/instance/compute/vmSize?api-version=2021-02-01",
		map[string]string{"Metadata": "true"})
}

// stableHostIdentity is the non-cloud fallback, used when no metadata service
// answered. /sys/class/dmi/id/product_name is set by firmware/the hypervisor and
// stable across reboots on real hardware and most non-cloud hypervisors alike;
// runtime.GOOS/GOARCH is the last resort so this always returns SOMETHING rather
// than an empty string a caller might mistake for "no host identity exists".
func stableHostIdentity() string {
	if b, err := os.ReadFile("/sys/class/dmi/id/product_name"); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			return s
		}
	}
	return runtime.GOOS + "/" + runtime.GOARCH
}

// verifyInstanceType refuses loudly, naming both values, when the manifest's
// recorded InstanceType does not match what detect reports for the running host --
// unless the operator has explicitly opted out via instanceTypeCheckOverrideEnv.
// detect is injected (rather than called directly) so tests exercise this without
// touching the network. An empty manifestType (an old manifest predating this
// field) or an undetectable host both fail OPEN, not closed: this check is meant to
// catch a real, recorded mismatch, not to block startup when there is nothing to
// compare.
func verifyInstanceType(get func(string) string, manifestType string, detect func(context.Context) string) error {
	if manifestType == "" {
		return nil
	}
	if skip, err := strconv.ParseBool(get(instanceTypeCheckOverrideEnv)); err == nil && skip {
		log.Printf("microvm-worker: %s=true, skipping instance-type verification (snapshot recorded %q)",
			instanceTypeCheckOverrideEnv, manifestType)
		return nil
	}
	host := detect(context.Background())
	if host == "" || host == manifestType {
		return nil
	}
	return fmt.Errorf("snapshot was built on instance type %q but this host reports %q "+
		"(spec §2.4: restore requires identical hardware; set %s=true to override deliberately)",
		manifestType, host, instanceTypeCheckOverrideEnv)
}

func nextBackoff(d time.Duration) time.Duration { return min(d*2, backoffMax) }

func jitter(d time.Duration) time.Duration {
	return d + time.Duration(rand.Int64N(int64(d/2)+1))
}

// diagStats is the wire shape of SH_DIAG_STATS_ADDR's /stats, kept separate from
// vmpool.Stats on purpose: this is a contract something outside the process parses, and it
// should not change silently because an internal field was renamed. Field-for-field
// otherwise, and the two maps are stringified the way vmpoolctl already does it.
type diagStats struct {
	InFlight             int    `json:"inFlight"`
	ActiveRuns           int    `json:"activeRuns"`
	ParkedRuns           int    `json:"parkedRuns"`
	StandbysResident     int    `json:"standbysResident"`
	IdleStandbyResidency int    `json:"idleStandbyResidency"`
	CommittedBytes       int64  `json:"committedBytes"`
	WarmAcquires         uint64 `json:"warmAcquires"`
	// Reported by the worker rather than recorded by the driver from what it believes it
	// set. Every E11 microVM rung ever recorded swept c to 64 against a 4-slot cap the
	// driver never set and never wrote down, and at every point measured so far it was
	// this -- not the pool -- that set throughput (#305). A rung record must not be
	// readable without its slot count.
	MaxConcurrent int `json:"maxConcurrent"`
	// Keyed by cause. "exhausted" is the one that means replenishment is behind the Exec
	// rate; "first-exec" is a session's unavoidable first restore. A bare total conflates
	// them, and a density knee can only be attributed to the former.
	ColdAcquires      map[string]uint64 `json:"coldAcquires"`
	Refusals          map[string]uint64 `json:"refusals"`
	Replenishments    uint64            `json:"replenishments"`
	ReplenishFailures uint64            `json:"replenishFailures"`
	DestroyFailures   uint64            `json:"destroyFailures"`
	// Both "the deferral did not apply" reasons, each with its own number: a saturated reaper
	// and an unreadable barrier are different problems and the first thing to check when a
	// deferral arm measures flat.
	ReapsInline       uint64 `json:"reapsInline"`
	BarrierUnobserved uint64 `json:"barrierUnobserved"`
	TimeoutsClamped   uint64 `json:"timeoutsClamped"`
}

func toDiagStats(st vmpool.Stats, maxConcurrent int) diagStats {
	out := diagStats{
		MaxConcurrent:        maxConcurrent,
		InFlight:             st.InFlight,
		ActiveRuns:           st.ActiveRuns,
		ParkedRuns:           st.ParkedRuns,
		StandbysResident:     st.StandbysResident,
		IdleStandbyResidency: st.IdleStandbyResidency,
		CommittedBytes:       st.CommittedBytes,
		WarmAcquires:         st.WarmAcquires,
		ColdAcquires:         map[string]uint64{},
		Refusals:             map[string]uint64{},
		Replenishments:       st.Replenishments,
		ReplenishFailures:    st.ReplenishFailures,
		DestroyFailures:      st.DestroyFailures,
		ReapsInline:          st.ReapsInline,
		BarrierUnobserved:    st.BarrierUnobserved,
		TimeoutsClamped:      st.TimeoutsClamped,
	}
	for k, v := range st.ColdAcquires {
		out.ColdAcquires[string(k)] = v
	}
	for k, v := range st.Refusals {
		out.Refusals[string(k)] = v
	}
	return out
}

// diagStatsMux serves the pool's real acquire counters for SH_DIAG_STATS_ADDR.
//
// This exists because e11-density.sh's coldAcquireRate is a latency-classification proxy
// (Execs slower than SH_E11_COLD_LATENCY_MS), which measured 13x off at c=8 and ~250x off
// at c=16 against the true rate, and cannot be fixed by tuning that threshold: Acquire is
// 0.3% of an Exec, so no end-to-end latency threshold separates warm from cold. vmpool has
// always maintained the real figures; until now only vmpoolctl could read them (#306).
//
// Deliberately its OWN mux, never http.DefaultServeMux: this package imports
// _ "net/http/pprof", whose handlers register on the default mux at import time, so
// serving /stats there would mean enabling counters also exposed heap contents, goroutine
// dumps and command lines. That exposure is SH_DIAG_PPROF's documented, opt-in bargain
// (#308) and must not arrive behind a different variable.
func diagStatsMux(statsFn func() vmpool.Stats, maxConcurrent int) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/stats", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(toDiagStats(statsFn(), maxConcurrent)); err != nil {
			log.Printf("microvm-worker: SH_DIAG_STATS_ADDR encode failed: %v", err)
		}
	})
	return mux
}

func main() {
	// Opt-in profiling. OFF unless SH_DIAG_PPROF names a bind address, because pprof
	// serves goroutine dumps, heap contents and command lines to anyone who can reach
	// it -- bind loopback (127.0.0.1:6060) and reach it over ssh, never 0.0.0.0.
	//
	// It is here because its absence cost a day: the worker's hot path could only be
	// localised by SIGQUIT-ing it (which kills it) after a block profile turned out to
	// be unavailable. See #305.
	if addr := os.Getenv("SH_DIAG_PPROF"); addr != "" {
		runtime.SetBlockProfileRate(10000) // ~1 sample per 10us blocked
		runtime.SetMutexProfileFraction(5)
		go func() {
			log.Printf("microvm-worker: SH_DIAG_PPROF listening on %s: %v", addr, http.ListenAndServe(addr, nil))
		}()
	}

	get := os.Getenv
	cfg, err := poolConfig(get)
	if err != nil {
		log.Fatalf("microvm-worker: %v", err)
	}
	// snapDir must be resolved before launcherFor: the Firecracker arm's
	// FirecrackerOptions.SnapshotDir IS this directory (the golden vmstate/memfile/
	// kernel/rootfs/agent/manifest.json set), not cfg.SnapshotDir itself, which is
	// only the parent directory a specific image lives under.
	snapDir := filepath.Join(cfg.SnapshotDir, env(get, "SH_SNAPSHOT_IMAGE", "default"))
	lc, err := launcherFor(cfg.VMM, get, snapDir, vmpool.PerVMBytes(cfg))
	if err != nil {
		log.Fatalf("microvm-worker: %v", err)
	}
	pool, err := vmpool.New(cfg, lc, vmpool.RealClock())
	if err != nil {
		log.Fatalf("microvm-worker: %v", err)
	}
	defer func() { _ = pool.Close() }()

	// Verify, pin and probe BEFORE the Attach stream opens, because registration IS
	// the live stream (remote-worker/DESIGN.md:29-30): a worker that registers and then
	// discovers it cannot restore has already been given work. Spec §6: fail at start,
	// not on a user's first request.
	man, err := vmpool.LoadManifest(snapDir)
	if err != nil {
		log.Fatalf("microvm-worker: %v", err)
	}
	if err := man.Verify(snapDir); err != nil {
		log.Fatalf("microvm-worker: %v", err)
	}
	if err := verifyInstanceType(get, man.InstanceType, detectHostInstanceType); err != nil {
		log.Fatalf("microvm-worker: %v", err)
	}
	unpin, err := vmpool.PinMemoryFile(filepath.Join(snapDir, "memfile"))
	if err != nil {
		log.Fatalf("microvm-worker: %v", err)
	}
	defer func() { _ = unpin() }()

	// Task 17 (spec §6's #1 practical failure: a worker crash leaks VMs). Both steps
	// below run before Probe, in the same "fail at start, not on a user's first
	// request" posture as everything else in this block.
	soft, hard, err := vmpool.RaiseMemlockLimit()
	if err != nil {
		log.Fatalf("microvm-worker: RLIMIT_MEMLOCK: %v", err)
	}
	// Recorded, per spec §7.5: a kernel limit mistaken for a density ceiling fails at
	// 500 VMs after working at 20, indistinguishably from the real thing.
	log.Printf("microvm-worker: RLIMIT_MEMLOCK soft=%d hard=%d", soft, hard)

	// Orphans from a previous incarnation. Spec §6's #1 practical failure: without this,
	// a crash-restart loop leaks VMs at the crash rate and every density number after it
	// is a fiction. Arm-agnostic (hardware-corrections D3): this walks whatever either
	// VMM's cgroup-creation mechanism left under the slice, keyed on cgroup.procs pids
	// rather than process names (D8: cloud-hypervisor's comm is truncated to 15 chars by
	// the kernel, so a name-based sweep would silently miss that arm's orphans).
	//
	// The sweep is fail-closed (final review H1): it touches only cgroup directories
	// this pool itself named, and never its own. What it declined is logged as well as
	// what it swept, because a filter that has narrowed to nothing and a slice that
	// genuinely has no orphans are otherwise indistinguishable from the outside — and
	// the shipped unit's own Slice=microvm-vms.slice guarantees at least one skip
	// (microvm-worker.service, this process's own cgroup), so an EMPTY skip list on a
	// systemd-started worker is itself the anomaly worth seeing.
	//
	// SH_PARENT_CGROUP is slice-RELATIVE, because jailer refuses an absolute
	// --parent-cgroup outright (verified on hardware; see vmpool.DefaultParentCgroup).
	// Only the sweep needs it absolute, and deriving it here rather than configuring it
	// twice is what stops the sweep and the launcher from pointing at different places --
	// which is exactly what shipped: the sweep at a path that did not exist, so it
	// no-oped silently, and the launcher at a bare slice name, so every VM cgroup landed
	// OUTSIDE the slice systemd accounts.
	parentCgroup := env(get, "SH_PARENT_CGROUP", vmpool.DefaultParentCgroup)
	if err := vmpool.ValidateParentCgroup(parentCgroup); err != nil {
		log.Fatalf("microvm-worker: %v", err)
	}
	sweepPath := vmpool.ParentCgroupPath(parentCgroup)
	// Under systemd the slice is created before this unit starts, so an absent path is a
	// misconfiguration and the sweep would silently do nothing -- section 6's #1
	// mitigation disabled without a word. Outside systemd (gates, vmpoolctl, a dev box)
	// absence is normal, so it is a warning there. systemd sets INVOCATION_ID for every
	// unit it starts.
	if _, statErr := os.Stat(sweepPath); statErr != nil {
		if get("INVOCATION_ID") != "" {
			log.Fatalf("microvm-worker: SH_PARENT_CGROUP=%q resolves to %s, which does not exist, "+
				"so the orphan sweep would do nothing and crash-leaked VMs from a previous "+
				"incarnation would stay resident against the memory gate. Note systemd expands a "+
				"dashed slice name into a hierarchy, so the unit microvm-vms.slice lives at %q",
				parentCgroup, sweepPath, vmpool.DefaultParentCgroup)
		}
		log.Printf("microvm-worker: orphan sweep skipped: %s does not exist (normal outside systemd)", sweepPath)
	} else if res, err := vmpool.SweepOrphans(sweepPath); err != nil {
		log.Printf("microvm-worker: orphan sweep: %v", err)
	} else {
		log.Printf("microvm-worker: orphan sweep: swept %d VM cgroup(s) from a previous incarnation; left alone %d non-VM cgroup(s) %v",
			res.Swept, len(res.Skipped), res.Skipped)
	}

	if err := pool.Probe(context.Background()); err != nil {
		log.Fatalf("microvm-worker: %v", err)
	}
	log.Printf("microvm-worker: snapshot %s verified and pinned (%s, built %s on %s)",
		man.Image, man.Hash, man.BuiltAt.Format(time.RFC3339), man.InstanceType)

	relayAddr := env(get, "RELAY_ADDR", "localhost:8443")
	token := env(get, "SANDBOX_TOKEN", "dev-token")
	useTLS, err := strconv.ParseBool(env(get, "RELAY_TLS", "false"))
	if err != nil {
		// Same posture as cmd/worker: this gates whether the bearer token crosses the
		// wire in cleartext, so the worker refuses to guess.
		log.Fatalf("microvm-worker: RELAY_TLS=%q is not a boolean", get("RELAY_TLS"))
	}
	maxConcurrent, err := workerMaxConcurrent(get)
	if err != nil {
		// Same posture as RELAY_TLS above: a value the operator clearly meant to set, and that
		// the worker cannot honour, stops the unit rather than being silently replaced by a
		// default that would misreport the run's slot count.
		log.Fatalf("microvm-worker: %v", err)
	}

	// Opt-in, and separate from SH_DIAG_PPROF so obtaining the counters does not require
	// exposing heap dumps and command lines. Bind loopback and reach it over ssh. Placed
	// here, after maxConcurrent is resolved, because /stats reports it: the driver should
	// record the slot count the worker is actually using, not the one it believes it set.
	if addr := env(get, "SH_DIAG_STATS_ADDR", ""); addr != "" {
		statsSrv := &http.Server{
			Addr:              addr,
			Handler:           diagStatsMux(pool.Stats, maxConcurrent),
			ReadHeaderTimeout: 5 * time.Second,
		}
		go func() {
			log.Printf("microvm-worker: SH_DIAG_STATS_ADDR listening on %s: %v", addr, statsSrv.ListenAndServe())
		}()
		defer func() { _ = statsSrv.Close() }()
	}

	var creds credentials.TransportCredentials
	if useTLS {
		creds = credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})
	} else {
		creds = insecure.NewCredentials()
	}
	conn, err := grpc.NewClient(relayAddr, session.DialOptions(creds)...)
	if err != nil {
		log.Fatalf("microvm-worker: dial %s: %v", relayAddr, err)
	}
	defer conn.Close()
	client := pb.NewSandboxWorkerClient(conn)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; log.Println("microvm-worker: signal received, shutting down"); cancel() }()

	// Capabilities are NOT probed from the worker's own PATH here: the commands run in
	// a guest, so the worker's PATH says nothing about what an Exec can use. They come
	// from the golden snapshot's manifest loaded above instead, which the build script
	// fills by probing INSIDE the guest before snapshotting; an empty manifest field
	// advertises nothing rather than lying.
	sess := session.New(session.Config{
		SandboxID:     env(get, "SANDBOX_ID", "sbx-microvm-1"),
		Image:         env(get, "SANDBOX_IMAGE", ""),
		Trust:         env(get, "SANDBOX_TRUST", "untrusted"),
		Capabilities:  man.Capabilities,
		MaxConcurrent: maxConcurrent,
	}, vmpool.Runner{Pool: pool})

	// slots is in the banner because this tier's default is 16 while the shipped unit sets
	// no WORKER_MAX_CONCURRENT: without it an upgrade moves 4 -> 16 dispatch slots with
	// nothing in journalctl naming the number, and /stats is gated behind the opt-in
	// SH_DIAG_STATS_ADDR. cmd/worker logs the same thing as capacity=%d. #305's own thesis
	// is that a run whose slots came from a typo must not look like a run that chose them.
	log.Printf("microvm-worker: relay=%s sandbox_id=%s tls=%v vmm=%s D=%d guest=%dMiB budget=%dMiB slots=%d",
		relayAddr, env(get, "SANDBOX_ID", "sbx-microvm-1"), useTLS, cfg.VMM,
		cfg.StandbyDepth, cfg.GuestRAMBytes>>20, cfg.MaxCommittedBytes>>20, maxConcurrent)
	if w := slotBudgetWarning(cfg, maxConcurrent); w != "" {
		log.Printf("microvm-worker: %s", w)
	}

	backoff := backoffMin
	for ctx.Err() == nil {
		attachCtx := metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)
		stream, err := client.Attach(attachCtx)
		if err == nil {
			log.Printf("microvm-worker: attached, serving execs")
			start := time.Now()
			err = sess.Serve(attachCtx, stream)
			if time.Since(start) > 30*time.Second {
				backoff = backoffMin
			}
		}
		if ctx.Err() != nil {
			break
		}
		wait := jitter(backoff)
		log.Printf("microvm-worker: stream ended (%v); reconnecting in %s", err, wait.Round(time.Millisecond))
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		backoff = nextBackoff(backoff)
	}
	log.Println("microvm-worker: stopped")
}
