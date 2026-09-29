// Command vmpoolctl drives vmpool directly — no relay, no harness, no protocol
// confound (spec §3.1). It is E10's driver: its rungs are terms, not concurrency, so
// it reports the hot path decomposed into acquire / run / destroy rather than one
// round-trip number.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

// runResult is the record E10's shell driver parses. Every field exists because a
// rung is unreportable without it; spec §6 additionally requires the substrate
// recorded in every run record, which is what VMM and Host are for.
type runResult struct {
	VMM         string `json:"vmm"`
	Host        string `json:"host"`
	Key         string `json:"key"`
	Command     string `json:"command"`
	Mode        string `json:"mode"`
	Iterations  int    `json:"iterations"`
	Concurrency int    `json:"concurrency"`
	// DeferReapWorkers records WHICH ARM this rung ran, because the deferred reap (#307)
	// is an A/B on one binary. 0 is the synchronous teardown.
	// ReapsInline counts deferred reaps that ran on the caller's goroutine because the
	// reaper was saturated, i.e. teardowns that paid the synchronous cost anyway. Nonzero
	// means the arm was only PARTLY applied, which is the first thing to check when a
	// deferral rung measures flat.
	ReapsInline      uint64 `json:"reaps_inline"`
	DeferReapWorkers int    `json:"defer_reap_workers"`
	// ReplenishDelayMs is recorded for the same reason: it is the grace before a popped slot
	// is refilled, and at 64 slots the 200 ms default is longer than a slot's whole cycle.
	ReplenishDelayMs int `json:"replenish_delay_ms"`
	// Keys is recorded because on the Firecracker arm it, not Concurrency, bounds how
	// many VMs were ever alive at once (SerializesExecsPerRun). A record carrying
	// concurrency without keys is the one that cannot be read back correctly -- #307's
	// original table is the worked example.
	Keys            int               `json:"keys"`
	WarmupDiscarded int               `json:"warmup_discarded"`
	Failures        int               `json:"failures"`
	StandbyDepth    int               `json:"standby_depth"`
	GuestRAMMB      int64             `json:"guest_ram_mb"`
	Substrate       string            `json:"substrate"`
	MemfilePinned   bool              `json:"memfile_pinned"`
	Limits          map[string]string `json:"limits"`
	WarmAcquires    uint64            `json:"warm_acquires"`
	ColdAcquires    map[string]uint64 `json:"cold_acquires"`
	Refusals        map[string]uint64 `json:"refusals"`
	P50AcquireUs    int64             `json:"p50_acquire_us"`
	P95AcquireUs    int64             `json:"p95_acquire_us"`
	P50ResumeUs     int64             `json:"p50_resume_us"`
	P95ResumeUs     int64             `json:"p95_resume_us"`
	// Resume's three sub-phases (Firecracker only; zero on the CHV arm, which has no
	// workspace mount). They sum to resume_us, which keeps its old meaning so that
	// earlier campaign tables stay comparable -- see vmpool.Phases.
	P50VMResumeUs  int64 `json:"p50_vmresume_us"`
	P95VMResumeUs  int64 `json:"p95_vmresume_us"`
	P50VsockDialUs int64 `json:"p50_vsockdial_us"`
	P95VsockDialUs int64 `json:"p95_vsockdial_us"`
	P50MountUs     int64 `json:"p50_mount_us"`
	P95MountUs     int64 `json:"p95_mount_us"`
	P50RunUs       int64 `json:"p50_run_us"`
	P95RunUs       int64 `json:"p95_run_us"`
	P50DestroyUs   int64 `json:"p50_destroy_us"`
	P95DestroyUs   int64 `json:"p95_destroy_us"`
	P50TotalUs     int64 `json:"p50_total_us"`
	P95TotalUs     int64 `json:"p95_total_us"`
	WallMs         int64 `json:"wall_ms"`
	CPUChildUs     int64 `json:"cpu_child_us"`
}

// sample holds one measured iteration's phase decomposition. Every mode fills in
// only the fields its own primitive touches — e.g. "replenish" never sets run, and
// leaving the rest at their zero value is exactly what keeps a replenishment rung
// from being misread as a hot-path rung (see TestModeReplenishMeasuresRestoreOnly).
type sample struct {
	acquire, resume, run, destroy, total time.Duration
	// Resume's sub-phases. Zero on every mode but "exec", and zero on the CHV arm,
	// for the same reason the other fields are: a mode fills only what it touches.
	vmResume, vsockDial, mount time.Duration
}

func main() {
	if err := realMain(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "vmpoolctl: %v\n", err)
		os.Exit(1)
	}
}

func realMain(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("vmpoolctl", flag.ContinueOnError)
	fs.SetOutput(io.Discard) // errors are returned, not printed twice
	defaultSubstrate := os.Getenv("SH_SUBSTRATE")
	if defaultSubstrate == "" {
		defaultSubstrate = "unknown"
	}
	var (
		vmm         = fs.String("vmm", "fake", "cloud-hypervisor | firecracker | fake (host bash, NOT a sandbox)")
		snapshotDir = fs.String("snapshot-dir", "", "directory holding the golden snapshot")
		wsRoot      = fs.String("workspace-root", "", "directory holding per-run workspaces")
		key         = fs.String("key", "", "workspace_key to run under")
		depth       = fs.Int("standby-depth", vmpool.DefaultStandbyDepth, "D")
		bulkKeys    = fs.Int("bulk-keys", 0, "teardown-bulk only: run pools per batch; 0 derives a batch of MaxReclaimsPerScan VMs")
		guestMB     = fs.Int64("guest-ram-mb", vmpool.DefaultGuestRAMBytes>>20, "guest RAM per VM, MiB")
		maxRuns     = fs.Int("max-runs", 64, "MaxRuns backstop")
		committedMB = fs.Int64("max-committed-mb", 32<<10, "MaxCommittedBytes, MiB")
		iterations  = fs.Int("iterations", 1, "how many Execs to run")
		concurrency = fs.Int("concurrency", 1, "how many Execs in flight at once")
		keys        = fs.Int("keys", 1,
			"mode=exec only: spread the Execs across this many distinct workspace_keys. "+
				"REQUIRED to exceed one VM in flight on the Firecracker arm: that launcher "+
				"reports SerializesExecsPerRun, so a run's execGate admits one Exec at a time "+
				"and --concurrency alone only queues goroutines at that gate. --keys=1 "+
				"(the default) reproduces the historical single-key behaviour")
		replenishMs = fs.Int("replenish-delay-ms", int(vmpool.DefaultReplenishDelay/time.Millisecond),
			"grace before refilling a popped standby slot. The 200ms default exceeds a slot's whole "+
				"cycle at 64 slots, so replenishment starts after the slot has already gone cold (#307)")
		deferReap = fs.Int("defer-reap-workers", 0,
			"move the VM reap tail (cmd.Wait, jail unlink, cgroup release) off the execGate-held "+
				"path onto this many background workers, releasing the gate at the descriptor barrier "+
				"instead (#307). 0 keeps teardown synchronous, which is the arm to compare against. "+
				"64 is the size to reach for: the pipeline turns over ~870 VMs/s at its peak and a "+
				"reap is ~53 ms, so ~46 tails are in flight there, and they are blocking latency "+
				"rather than CPU -- the kernel absorbs reaps concurrently (49/s at c=1 to 1131/s at c=64)")
		timeoutS = fs.Uint("timeout-s", 30, "per-Exec timeout")
		asJSON   = fs.Bool("json", false, "emit one runResult JSON record")
		mode     = fs.String("mode", "exec",
			"exec | replenish | teardown-inflight | teardown-standby | teardown-bulk (spec §7.2)")
		warmup = fs.Int("warmup", -1,
			"iterations to discard before measuring; -1 means min(iterations/10, 5) (spec §7.5)")
		substrate = fs.String("substrate", defaultSubstrate,
			"substrate label recorded in every record (spec §6); defaults to $SH_SUBSTRATE, else \"unknown\"")
		pinMemfile = fs.Bool("pin-memfile", true,
			"mlock the snapshot memfile before measuring — the density mechanism (spec §7.5, hardware-corrections E5)")
		stdin = fs.String("stdin", "",
			"bytes to feed the command's stdin (mode=exec only). Non-empty forces "+
				"vmpool.Exec.HasStdin, which on a real launcher selects the guest agent's "+
				"freshly-forked-child path rather than the parked bash (spec §5.4) — this is "+
				"how E10 rung 2 prices parked vs fresh, since the guest agent has no "+
				"standalone mode toggle of its own; the choice is per-request, driven by "+
				"whether the request carries stdin")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	switch *mode {
	case "exec", "replenish", "teardown-inflight", "teardown-standby", "teardown-bulk":
	default:
		return fmt.Errorf("--mode=%q is not one of exec, replenish, teardown-inflight, teardown-standby, teardown-bulk", *mode)
	}
	// Join rather than take command[0]: "-- echo hello world" means what it looks
	// like, and an already-quoted single argument still passes through unchanged.
	// Silently running only the first word would let a run measure a different,
	// possibly no-op command while reporting a clean, plausible result. Required in
	// every mode, even the ones that never run it, so every rung's invocation has
	// the same shape and a record always carries what was asked for.
	command := strings.Join(fs.Args(), " ")
	if command == "" {
		return fmt.Errorf("a command is required after --")
	}
	if *iterations < 1 || *concurrency < 1 {
		return fmt.Errorf("--iterations and --concurrency must be >= 1")
	}
	if *keys < 1 {
		return fmt.Errorf("--keys must be >= 1")
	}
	// Refused rather than silently clamped. On the Firecracker arm --concurrency above
	// --keys cannot be delivered -- the surplus goroutines park on some run's execGate --
	// and a record reporting concurrency=16 keys=1 is exactly the shape that made #307's
	// original c=8/c=16 table read as "Destroy does not scale with load" when both columns
	// had in fact run one VM at a time. Clamping would produce the same wrong record with a
	// warning nobody reads.
	//
	// THIS CONDITION MIRRORS firecrackerLauncher.SerializesExecsPerRun, which is the
	// authority on it, and must be updated if a second arm ever reports true: a new
	// serializing launcher would otherwise accept --concurrency > --keys and produce exactly
	// the unreadable record this refusal exists to prevent. It is not asked of the launcher
	// directly because lc is not constructed until below, and reordering construction ahead
	// of flag validation to satisfy one check is the more fragile trade. Compared against
	// the VMMKind constant rather than a raw string so this stays in step with launcher()
	// if the wire name changes.
	if *keys < *concurrency && *mode == "exec" && *vmm == string(vmpool.Firecracker) {
		return fmt.Errorf("--concurrency=%d needs --keys>=%d on the firecracker arm: it "+
			"SerializesExecsPerRun, so %d key(s) admit at most %d Exec(s) at a time and the rest "+
			"would queue, recording a concurrency this run never reached", *concurrency, *concurrency, *keys, *keys)
	}
	// A mode that ignores --concurrency must REFUSE it, never run at c=1 under a c=N
	// label. Before this, every mode except exec accepted the flag, echoed "conc=4" into
	// its own record, and ran a serial loop -- so a teardown or replenishment rung swept
	// across concurrency produced a table whose columns differed by nothing at all. That
	// is not hypothetical: #307's "flat across c=8/c=16" finding was published from the
	// same defect one layer over, where a single shared execGate rather than a serial loop
	// did the flattening. Same posture as the mode dispatcher's default case below: make
	// two lists that must agree disagree LOUDLY.
	switch *mode {
	case "exec", "replenish": // these honour it; every other mode is serial by construction
	default:
		if *concurrency > 1 {
			return fmt.Errorf("--mode=%s runs serially and ignores --concurrency=%d: it would "+
				"report a c=%d rung measured at c=1. Use --mode=exec or --mode=replenish to "+
				"sweep concurrency", *mode, *concurrency, *concurrency)
		}
	}
	// Spec §7.5: "The first restore differs from the hundredth (page cache, THP,
	// fragmentation). Discard warmup, report steady state." -1 is the "unset"
	// sentinel — 0 is a legitimate, explicit request for no warmup at all.
	warmupN := *warmup
	if warmupN < 0 {
		warmupN = *iterations / 10
		if warmupN > 5 {
			warmupN = 5
		}
		// With --keys>1 the default is also floored at one warmup per key. The warmup loop
		// round-robins the keys, so a default of 5 against --keys=64 would leave 59 run pools
		// cold and charge their first restores to the MEASURED window -- reintroducing exactly
		// the effect this warmup exists to exclude, and doing it in proportion to the variable
		// a slot sweep varies. Only the derived default is raised: an explicit --warmup is the
		// caller's decision and is left alone (including an explicit 0).
		// Guarded on keys>1, not on keys>warmupN: at the default --keys=1 there is one run
		// pool and the historical default must be returned unchanged, including the
		// --iterations=1 case where any floor at all would exceed it.
		if *mode == "exec" && *keys > 1 && *keys > warmupN {
			warmupN = *keys
		}
	}
	if warmupN >= *iterations {
		return fmt.Errorf("--warmup=%d must be less than --iterations=%d", warmupN, *iterations)
	}

	// perVMBytes is vmpool.PerVMBytes(cfg) (hardware-corrections D1) computed before
	// cfg itself exists below: cfg.VMM is derived from lc.Kind() once lc is built, so
	// building the whole Config first would be circular. Only GuestRAMBytes is needed
	// for the figure — VMOverheadBytes is left at its zero value here exactly as
	// cmd/microvm-worker/main.go's own launcherFor call does (poolConfig there never
	// sets it either), so both binaries compute the identical figure from the
	// identical inputs.
	perVMBytes := vmpool.PerVMBytes(vmpool.Config{GuestRAMBytes: *guestMB << 20})

	// Verify the snapshot against its own manifest before measuring anything with it, the
	// same check cmd/microvm-worker/main.go makes at startup. The asymmetry was itself a
	// defect: microvm-worker refused to start against a drifted snapshot while this binary
	// happily produced a full set of latency numbers from one, and a rung measured against
	// a corrupted image is not a degraded measurement -- it is a wrong one that looks fine.
	//
	// It matters here more than the phrase "diagnostic CLI" suggests, because E10's rungs
	// 2-4 are driven entirely through this binary: every microVM figure the ladder reports
	// comes from a run that until now never checked whether the image it restored was the
	// image the manifest describes. On the validation rig it was not -- a writable root
	// device had been mutating it (see build-snapshot.sh's is_read_only comment).
	//
	// Skipped for --vmm=fake, which has no snapshot to verify.
	if *vmm != "fake" {
		// Returned bare: main() already prefixes "vmpoolctl: " when it prints, and
		// wrapping here produced "vmpoolctl: vmpoolctl: snapshot ... drifted" on the rig.
		man, mErr := vmpool.LoadManifest(*snapshotDir)
		if mErr != nil {
			return mErr
		}
		if vErr := man.Verify(*snapshotDir); vErr != nil {
			return vErr
		}
	}

	lc, err := launcher(*vmm, *snapshotDir, perVMBytes)
	if err != nil {
		return err
	}
	cfg := vmpool.Config{
		VMM:               lc.Kind(),
		SnapshotDir:       *snapshotDir,
		WorkspaceRoot:     *wsRoot,
		StandbyDepth:      *depth,
		GuestRAMBytes:     *guestMB << 20,
		MaxRuns:           *maxRuns,
		MaxCommittedBytes: *committedMB << 20,
		DeferReapWorkers:  *deferReap,
		ReplenishDelay:    time.Duration(*replenishMs) * time.Millisecond,
	}
	pool, err := vmpool.New(cfg, lc, vmpool.RealClock())
	if err != nil {
		return err
	}
	defer func() { _ = pool.Close() }()

	// The replenish/teardown-* modes exercise the individual lifecycle primitives
	// through BenchmarkHooks, which is deliberately not part of Pool (nothing in the
	// request path may acquire a VM without Exec's destroy defer). vmpool.New always
	// returns the one concrete *pool type, which implements BenchmarkHooks, so this
	// assertion only fails if that invariant is ever broken — worth a clear error
	// rather than a nil-pointer panic three lines into a mode branch.
	var hooks vmpool.BenchmarkHooks
	if *mode != "exec" {
		h, ok := pool.(vmpool.BenchmarkHooks)
		if !ok {
			return fmt.Errorf("--mode=%s requires vmpool.BenchmarkHooks, but this Pool does not implement it", *mode)
		}
		hooks = h
	}

	host, _ := os.Hostname()
	res := runResult{
		VMM: *vmm, Host: host, Key: *key, Command: command, Mode: *mode,
		Iterations: *iterations, Concurrency: *concurrency, Keys: keysUsed(*mode, *keys),
		StandbyDepth: cfg.StandbyDepth, GuestRAMMB: *guestMB,
		Substrate:        *substrate,
		Limits:           gatherLimits(),
		DeferReapWorkers: *deferReap,
		ReplenishDelayMs: *replenishMs,
	}

	// --pin-memfile: mlock the snapshot's memory file so restores across VMs share
	// pages (spec §7.5, hardware-corrections E5 — "say what was actually done").
	// Non-fatal: MemfilePinned staying false is itself the record of what happened,
	// exactly like a bound RLIMIT_MEMLOCK — a silently-failed pin must never look
	// like a successful one.
	if *pinMemfile {
		if unpin, pinErr := vmpool.PinMemoryFile(filepath.Join(*snapshotDir, "memfile")); pinErr == nil {
			res.MemfilePinned = true
			defer func() { _ = unpin() }()
		}
	}

	// CPUChildUs: RUSAGE_CHILDREN's delta across the measured window. The VMMs this
	// binary launches (Firecracker's jailer, cloud-hypervisor) are children of this
	// process, so their CPU IS replenishment's CPU cost (spec §7.2, hardware-
	// corrections brief step 2). Non-fatal on error (e.g. windows): CPUChildUs stays
	// 0, which is diagnostic-only and never load-bearing for the rest of the record.
	cpuBefore, cpuBeforeErr := childCPUUsage()

	var firstErr error
	var samples []sample
	switch *mode {
	case "exec":
		samples, firstErr = runExecMode(pool, *key, command, []byte(*stdin), *timeoutS, *iterations, warmupN, *concurrency, *keys, &res)
	case "replenish":
		samples, firstErr = runReplenishMode(hooks, *key, *iterations, warmupN, *concurrency, &res)
	case "teardown-inflight", "teardown-standby":
		samples, firstErr = runTeardownPerVMMode(hooks, *mode, *key, *wsRoot, *iterations, warmupN, &res)
	case "teardown-bulk":
		samples, firstErr = runTeardownBulkMode(hooks, *key, *iterations, warmupN, bulkKeysFor(*bulkKeys, *depth), *depth, &res)
	default:
		// Guards DIVERGENCE between two lists that must agree: the flag validator's
		// accepted set (see the switch near the top of realMain) and this dispatcher's
		// cases. A mode added to the validator but not here would pass validation and
		// then fall straight through, leaving `samples` nil so every percentile computed
		// as 0 — while the process still exited 0. That record is indistinguishable from
		// a real rung whose timings fell below clock resolution, which is the same shape
		// as E11's mem_available_bytes defect (a sweep that wrote zero records and
		// exited 0). Unreachable while the two lists agree; TestEveryValidModeIsDispatched
		// is what keeps them agreeing, and this is what makes the disagreement loud
		// instead of silent.
		return fmt.Errorf("vmpoolctl: --mode %q passed validation but is not dispatched "+
			"(the validator's mode list and realMain's dispatch switch have diverged)", *mode)
	}
	res.WarmupDiscarded = warmupN

	if cpuAfter, cpuAfterErr := childCPUUsage(); cpuBeforeErr == nil && cpuAfterErr == nil {
		res.CPUChildUs = cpuAfter - cpuBefore
	}

	res.P50AcquireUs, res.P95AcquireUs = pct(samples, func(s sample) time.Duration { return s.acquire })
	res.P50ResumeUs, res.P95ResumeUs = pct(samples, func(s sample) time.Duration { return s.resume })
	res.P50VMResumeUs, res.P95VMResumeUs = pct(samples, func(s sample) time.Duration { return s.vmResume })
	res.P50VsockDialUs, res.P95VsockDialUs = pct(samples, func(s sample) time.Duration { return s.vsockDial })
	res.P50MountUs, res.P95MountUs = pct(samples, func(s sample) time.Duration { return s.mount })
	res.P50RunUs, res.P95RunUs = pct(samples, func(s sample) time.Duration { return s.run })
	res.P50DestroyUs, res.P95DestroyUs = pct(samples, func(s sample) time.Duration { return s.destroy })
	res.P50TotalUs, res.P95TotalUs = pct(samples, func(s sample) time.Duration { return s.total })

	st := pool.Stats()
	res.WarmAcquires = st.WarmAcquires
	res.ReapsInline = st.ReapsInline
	res.ColdAcquires = map[string]uint64{}
	for k, v := range st.ColdAcquires {
		res.ColdAcquires[string(k)] = v
	}
	res.Refusals = map[string]uint64{}
	for k, v := range st.Refusals {
		res.Refusals[string(k)] = v
	}

	if *asJSON {
		enc := json.NewEncoder(stdout)
		if err := enc.Encode(res); err != nil {
			return err
		}
	} else {
		fmt.Fprintf(stdout, "vmm=%s mode=%s key=%s iters=%d warmup=%d conc=%d failures=%d\n",
			res.VMM, res.Mode, res.Key, res.Iterations, res.WarmupDiscarded, res.Concurrency, res.Failures)
		fmt.Fprintf(stdout, "acquire p50=%dus p95=%dus  resume p50=%dus p95=%dus  run p50=%dus p95=%dus  destroy p50=%dus p95=%dus  total p50=%dus p95=%dus\n",
			res.P50AcquireUs, res.P95AcquireUs, res.P50ResumeUs, res.P95ResumeUs, res.P50RunUs, res.P95RunUs, res.P50DestroyUs, res.P95DestroyUs, res.P50TotalUs, res.P95TotalUs)
		fmt.Fprintf(stdout, "cpu_child=%dus memfile_pinned=%v substrate=%s\n", res.CPUChildUs, res.MemfilePinned, res.Substrate)
		fmt.Fprintf(stdout, "warm=%d cold=%v refusals=%v limits=%v\n", res.WarmAcquires, res.ColdAcquires, res.Refusals, res.Limits)
	}
	// A failed Exec is reported in the record AND as a non-zero exit, so a driver
	// that ignores the JSON still notices.
	return firstErr
}

// runExecMode is E10 rungs 1/2's shape: the pool owns acquire/run/destroy
// internally, so the CLI times the whole Exec and reports the decomposition the
// pool exposes through its phase callbacks — never a guess. See vmpool.Phases. The
// first warmupN iterations run sequentially and are discarded before the measured,
// concurrent loop begins; ReqIDs are offset by warmupN so every ReqID stays unique
// across the whole invocation.
//
// stdin, when non-empty, is carried on every Exec so vmpool.Exec.HasStdin (derived
// as len(Stdin) > 0 in guestconn.go) is true for the whole run — on a real launcher
// this selects the guest agent's freshly-forked-child path rather than the parked
// bash it would otherwise reuse (spec §5.4). This is the flag E10's rung 2 uses
// twice: once with stdin empty (parked bash) and once with it set (fresh
// `bash -c`), pricing the one distinction §5.4 draws.
// keysUsed reports how many distinct keys the run ACTUALLY used, which is what the record
// must carry. Only mode=exec spreads across keys -- the warmup floor and the round-robin are
// both gated on it -- so every other mode uses exactly one however --keys was set.
//
// Recording the flag instead would put "keys": 8 on a replenish run that used one, which is
// the same failure in miniature as the table this field was added to make unreadable-proof:
// a record that parses cleanly and means something other than what it says.
func keysUsed(mode string, keys int) int {
	if mode != "exec" {
		return 1
	}
	return keys
}

// execKey names the workspace_key iteration i runs under. With keys=1 it returns the
// bare key, so every historical invocation is byte-identical to what it was before
// --keys existed; above 1 it round-robins, which is what gives the Firecracker arm more
// than one execGate to hold and therefore more than one VM alive at a time.
func execKey(key string, keys, i int) string {
	if keys <= 1 {
		return key
	}
	return fmt.Sprintf("%s-k%d", key, i%keys)
}

func runExecMode(pool vmpool.Pool, key, command string, stdin []byte, timeoutS uint, iterations, warmupN, concurrency, keys int, res *runResult) ([]sample, error) {
	// Warmup walks the keys in the same round-robin as the measured loop, so every run
	// pool that will be used has already paid its first restore before timing starts.
	// Warming only key 0 would leave keys-1 of them cold and charge those first restores
	// to the measured window -- the "first restore differs from the hundredth" effect the
	// --warmup flag exists to exclude, reintroduced through the back door.
	for i := 0; i < warmupN; i++ {
		ph := &vmpool.Phases{}
		_, _ = pool.ExecPhased(context.Background(), execKey(key, keys, i), vmpool.Exec{
			ReqID: uint64(i + 1), Command: command, Stdin: stdin, TimeoutS: uint32(timeoutS), Streaming: true,
		}, discardSink{}, ph)
	}

	measured := iterations - warmupN
	samples := make([]sample, measured)
	var firstErr error
	var mu sync.Mutex
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < measured; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			var s sample
			t0 := time.Now()
			ph := &vmpool.Phases{}
			_, err := pool.ExecPhased(context.Background(), execKey(key, keys, i), vmpool.Exec{
				ReqID: uint64(warmupN + i + 1), Command: command, Stdin: stdin, TimeoutS: uint32(timeoutS), Streaming: true,
			}, discardSink{}, ph)
			s.total = time.Since(t0)
			s.acquire, s.resume, s.run, s.destroy = ph.Acquire, ph.Resume, ph.Run, ph.Destroy
			s.vmResume, s.vsockDial, s.mount = ph.VMResume, ph.VsockDial, ph.Mount
			mu.Lock()
			samples[i] = s
			if err != nil {
				res.Failures++
				if firstErr == nil {
					firstErr = err
				}
			}
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	res.WallMs = time.Since(start).Milliseconds()
	return samples, firstErr
}

// runReplenishMode is E10 rung 3: spawn -> restore -> pause -> ready, timed on its
// own via RestoreOne, with none of ExecPhased's acquire bookkeeping folded in. The
// restored VM is destroyed immediately after each measured sample, but OUTSIDE the
// timed window — replenishment cost is what is being priced, not teardown (rung 4's
// job). No command ever runs, so run/resume/destroy all stay at their zero value on
// every sample: reporting a run figure here would invite reading this rung as a hot
// path rung.
func runReplenishMode(hooks vmpool.BenchmarkHooks, key string, iterations, warmupN, concurrency int, res *runResult) ([]sample, error) {
	for i := 0; i < warmupN; i++ {
		if vm, err := hooks.RestoreOne(context.Background(), key); err == nil {
			_ = vm.Destroy()
		}
	}

	measured := iterations - warmupN
	samples := make([]sample, measured)
	var firstErr error
	var mu sync.Mutex
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < measured; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			t0 := time.Now()
			vm, err := hooks.RestoreOne(context.Background(), key)
			d := time.Since(t0)
			mu.Lock()
			samples[i].acquire = d
			samples[i].total = d
			if err != nil {
				res.Failures++
				if firstErr == nil {
					firstErr = err
				}
			}
			mu.Unlock()
			if err != nil {
				return
			}
			// Destroyed inside the goroutine but AFTER the sample is stamped, so it stays
			// out of the per-restore timing exactly as it did when this loop was serial.
			// It is inside the WALL window on purpose: at concurrency > 1 a real host is
			// restoring and reaping at the same time, so wall_ms/measured is the sustained
			// rate the pipeline can hold rather than a reciprocal of restore latency. That
			// is the quantity #307's deferred-reap question needs, and it makes this an
			// UPPER BOUND on Exec/s: every Exec must do at least this restore and this
			// destroy, plus a Resume and a Run this mode never issues.
			_ = vm.Destroy()
		}(i)
	}
	wg.Wait()
	res.WallMs = time.Since(start).Milliseconds()
	return samples, firstErr
}

// runTeardownPerVMMode is two of E10 rung 4's three variants (hardware-corrections
// brief step 2's "in-flight" and "paused standby"): SIGKILL to reaped, timed on its
// own. "teardown-standby" destroys a VM RestoreOne left paused, exactly as it comes
// back from Restore — never resumed, matching the standby state a parked run's VMs
// actually sit in. "teardown-inflight" additionally Resumes the VM first (outside
// the timed window) so the destroy being measured is of an active VM, the state a
// VM serving a live Exec is torn down from — pricing the one term "the sub-15ms
// literature assumes is free" (spec §7.2) in both of the states it actually occurs.
//
// The timed window also removes the run's workspace directory. On a real launcher,
// VM.Destroy already does equivalent I/O internally (SIGKILL, reap, then remove the
// per-VM jail root — see launcher_firecracker.go / launcher_chv.go's own Destroy),
// so this adds nothing there. Under --vmm=fake there is no process to kill and no
// jail root to remove — measured directly, a bare fakeHostVM.Destroy is a mutex
// lock and a map delete, consistently under 1us (well below what time.Duration.
// Microseconds' truncation can represent) and would report a false, misleading zero
// for the very rung meant to price "the one term the sub-15ms literature assumes is
// free." Folding the per-key workspace's real removal into the same window keeps the
// fake arm honest about there being real reclaim work, without it ever running on
// the two real launchers' own already-realistic number. The directory is recreated
// by the next iteration's RestoreOne (via ensureWorkspace) exactly as production
// does after any Reclaim, so this is self-consistent across iterations.
func runTeardownPerVMMode(hooks vmpool.BenchmarkHooks, mode, key, wsRoot string, iterations, warmupN int, res *runResult) ([]sample, error) {
	resumeFirst := mode == "teardown-inflight"
	dir := filepath.Join(filepath.Clean(wsRoot), key)
	warm := func() {
		vm, err := hooks.RestoreOne(context.Background(), key)
		if err != nil {
			return
		}
		if resumeFirst {
			_ = vm.Resume(context.Background())
		}
		_ = vm.Destroy()
		_ = os.RemoveAll(dir)
	}
	for i := 0; i < warmupN; i++ {
		warm()
	}

	measured := iterations - warmupN
	samples := make([]sample, measured)
	var firstErr error
	start := time.Now()
	for i := 0; i < measured; i++ {
		vm, err := hooks.RestoreOne(context.Background(), key)
		if err != nil {
			res.Failures++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if resumeFirst {
			_ = vm.Resume(context.Background())
		}
		t0 := time.Now()
		if err := vm.Destroy(); err != nil {
			res.Failures++
			if firstErr == nil {
				firstErr = err
			}
		}
		_ = os.RemoveAll(dir)
		d := time.Since(t0)
		samples[i].destroy = d
		samples[i].total = d
	}
	res.WallMs = time.Since(start).Milliseconds()
	return samples, firstErr
}

// bulkKeysFor sizes teardown-bulk's batch: how many run pools one batch spans, chosen so
// the batch holds MaxReclaimsPerScan VMs — the most a real sweep ever reclaims in one
// scan (sweep.go's own budget). That is the quantity this rung exists to price, so it is
// the quantity it builds, rather than whatever number happens to be in --iterations.
// Always at least 1: a batch of zero pools would measure nothing and report it as a
// destroy figure.
func bulkKeysFor(explicit, depth int) int {
	if explicit > 0 {
		return explicit
	}
	if depth < 1 {
		depth = 1
	}
	if k := vmpool.DefaultMaxReclaimsPerScan / depth; k > 0 {
		return k
	}
	return 1
}

// runTeardownBulkMode is E10 rung 4's third variant: a bulk reclaim of K x D standbys in
// one DestroyAllStandbys call, because "the per-VM number does not predict" the sweep's
// bulk reclaim (spec §7.2) and this rung exists to price that sweep directly rather than
// as K x D separate single-VM destroys. D is --standby-depth, the same knob production
// Config uses; K is --bulk-keys, and K synthetic keys are derived from --key
// (FillStandbys is per-key) so the batch spans multiple run pools exactly as a real
// sweep's bulk reclaim would, rather than D standbys under one key alone.
//
// K used to BE --iterations, and that was the defect that would have aborted the metal
// ladder. For every other mode --iterations is a repeat count: more iterations, more
// samples, same resource footprint. Here it silently meant more SIMULTANEOUS VMs, so
// E10's metal defaults (ITERS=200, D=2) asked for 400 concurrent microVMs — a batch ~50x
// larger than any the sweep can perform, which the admission budget then refused after
// ~57 keys, exiting non-zero with 143 counted failures. e10-lifecycle.sh's vmpoolctl_run
// dies on a non-zero exit, so rung 4 took the whole ladder with it; and the runbook's
// ITERS=5 smoke pass builds 10 VMs, so it could never have caught it. Fan-out now has
// its own knob and --iterations means iterations here too.
//
// Each iteration is a full fill-then-destroy cycle, with only the destroy timed — so R
// iterations yield R samples and a percentile that is a percentile, instead of the single
// measurement this rung used to report as both p50 and p95. Warmup iterations are
// discarded exactly as the per-VM variants discard theirs, which also makes the record's
// warmup_discarded field honest: it previously reported the flag's value for a mode that
// performed no warmup at all.
//
// The K subkeys are REUSED across iterations rather than freshly minted per iteration.
// Fresh keys would grow the pool's run map by K every iteration (R x K entries, 800 at
// metal defaults) and hit MaxRuns instead of the memory budget — the same class of
// failure one flag along. Reusing them keeps the live run count at K, which is the
// footprint the rung is supposed to have.
func runTeardownBulkMode(hooks vmpool.BenchmarkHooks, key string, iterations, warmupN, keys, depth int, res *runResult) ([]sample, error) {
	var firstErr error
	fail := func(err error) {
		res.Failures++
		if firstErr == nil {
			firstErr = err
		}
	}

	// One batch: fill K pools to D, then destroy everything pool-wide and return how
	// long that took. The fill is deliberately outside the returned duration.
	batch := func() (time.Duration, bool) {
		ok := true
		for k := 0; k < keys; k++ {
			subKey := fmt.Sprintf("%s-bulk%d", key, k)
			if err := hooks.FillStandbys(context.Background(), subKey, depth); err != nil {
				fail(err)
				ok = false
			}
		}
		start := time.Now()
		_, err := hooks.DestroyAllStandbys(context.Background())
		d := time.Since(start)
		if err != nil {
			fail(err)
			ok = false
		}
		return d, ok
	}

	for i := 0; i < warmupN; i++ {
		batch()
	}

	measured := iterations - warmupN
	// Appended on success only, never pre-sized and left zero-filled on failure: a
	// zero-valued sample is indistinguishable from a destroy too fast for the clock, and
	// it would drag the p50 of the very term this rung prices toward zero — making a run
	// with failures look FASTER than a clean one.
	samples := make([]sample, 0, measured)
	start := time.Now()
	for i := 0; i < measured; i++ {
		if d, ok := batch(); ok {
			samples = append(samples, sample{destroy: d, total: d})
		}
	}
	res.WallMs = time.Since(start).Milliseconds()
	return samples, firstErr
}

// launcher maps --vmm to a Launcher. "fake" is handled here and ONLY here — it must
// never be reachable from cmd/microvm-worker/main.go's launcherFor (spec §3.3, §3.5:
// nothing agent-influenced may execute outside a VM, and microvm-worker runs
// privileged). Firecracker and CloudHypervisor both delegate to
// vmpool.LauncherFromEnv, reading the SAME env vars cmd/microvm-worker/main.go's
// launcherFor does, so E10's driver measures the production configuration rather
// than a CLI-only variant, and so a fix to one arm's wiring (e.g. round 3's
// CloudHypervisor fix) cannot land in one binary's copy of this switch and not the
// other's — see LauncherFromEnv's doc comment for why round 9 exists at all.
//
// Fix round 9 (Task 16): the CloudHypervisor case below used to be a hardcoded
// "--vmm=%s is not wired yet (Phase D)" error — the exact defect round 3 had already
// fixed in cmd/microvm-worker/main.go's launcherFor, recurring here because this
// file's copy of the switch was never updated when that fix landed. Grepping the repo
// for "Phase D" and for any other --vmm/SH_VMM switch turned up exactly one other
// production call site (main.go's launcherFor, already correct) and one test-only
// helper (internal/vmpool/gates_kvm_test.go's launcherForArm, which already called
// NewCloudHypervisorLauncher directly and never carried this placeholder) — no third
// site is left uninspected.
func launcher(kind string, snapshotDir string, perVMBytes int64) (vmpool.Launcher, error) {
	switch kind {
	case "fake":
		return vmpool.NewFakeLauncher(), nil
	case string(vmpool.Firecracker), string(vmpool.CloudHypervisor):
		// "vmpoolctl" differs from main.go's "microvm-worker" so the default RunDir
		// vmpool.LauncherFromEnv derives (chvDefaultRunDir, fix round 10 — a
		// same-device sibling of snapshotDir, not a hardcoded /run/... path any more)
		// never collides with microvm-worker's own default when this CLI is run for
		// diagnostics on the same host as a live microvm-worker daemon pointed at the
		// same snapshot; SH_CHV_RUN_DIR still overrides either the same way.
		return vmpool.LauncherFromEnv(vmpool.VMMKind(kind), os.Getenv, snapshotDir, perVMBytes, "vmpoolctl")
	default:
		return nil, fmt.Errorf("--vmm=%q is not one of cloud-hypervisor, firecracker, fake", kind)
	}
}

type discardSink struct{}

func (discardSink) Stdout([]byte) {}
func (discardSink) Stderr([]byte) {}

// pct returns p50 and p95 in microseconds. Nearest-rank on a sorted copy: with the
// small sample counts E10's rungs use, interpolation would invent precision.
func pct[T any](xs []T, get func(T) time.Duration) (p50, p95 int64) {
	if len(xs) == 0 {
		return 0, 0
	}
	ds := make([]time.Duration, len(xs))
	for i, x := range xs {
		ds[i] = get(x)
	}
	sort.Slice(ds, func(i, j int) bool { return ds[i] < ds[j] })
	at := func(q float64) int64 {
		i := int(q*float64(len(ds)-1) + 0.5)
		return ds[i].Microseconds()
	}
	return at(0.50), at(0.95)
}
