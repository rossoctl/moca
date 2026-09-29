package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

// testPerVMBytes stands in for the real vmpool.PerVMBytes(cfg) figure realMain
// computes — any positive value works here, since this test does not assert the
// SPECIFIC memory bound reaches the launcher (that agreement is asserted at the
// vmpool package level). What matters is only that it is > 0, so
// CHVOptions.validate() does not refuse the ParentCgroup default
// vmpool.LauncherFromEnv always sets (hardware-corrections D1). Mirrors
// cmd/microvm-worker/main_test.go's testPerVMBytes exactly.
const testPerVMBytes = int64(256 << 20)

// Fix round 9: launcher's CloudHypervisor case must actually route to
// vmpool.LauncherFromEnv / NewCloudHypervisorLauncher. Before this, the case was a
// hardcoded "not wired yet (Phase D)" error — the second occurrence of the exact
// defect round 3 fixed in cmd/microvm-worker/main.go's launcherFor, because that
// fix never propagated into this file's own copy of the switch. Mirrors
// TestLauncherForWiresCloudHypervisor's shape exactly.
func TestLauncherWiresCloudHypervisor(t *testing.T) {
	lc, err := launcher(string(vmpool.CloudHypervisor), t.TempDir(), testPerVMBytes)
	if err != nil {
		t.Fatalf("launcher(cloud-hypervisor): %v", err)
	}
	if lc.Kind() != vmpool.CloudHypervisor {
		t.Fatalf("Kind() = %v, want %v", lc.Kind(), vmpool.CloudHypervisor)
	}
	if lc.SerializesExecsPerRun() {
		t.Fatal("the Cloud Hypervisor arm must not serialize execs per run (spec §4.3): " +
			"virtio-fs makes the host filesystem, not a guest-owned block device, the " +
			"concurrency authority")
	}
}

// run invokes the CLI's real entry point in-process, so the test exercises flag
// parsing and the JSON contract E10's shell driver depends on — not a re-implementation
// of them.
func run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := realMain(args, &out)
	return out.String(), err
}

func TestRunsOneExecInAVMAndReportsItAsJSON(t *testing.T) {
	dir := t.TempDir()
	out, err := run(t,
		"--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
		"--key=run-a", "--iterations=3", "--json", "--", "echo hello")
	if err != nil {
		t.Fatalf("realMain: %v (out=%s)", err, out)
	}
	var rec runResult
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &rec); err != nil {
		t.Fatalf("output is not one JSON record: %v\n%s", err, out)
	}
	if rec.Iterations != 3 || rec.Failures != 0 {
		t.Fatalf("record = %+v, want 3 iterations and 0 failures", rec)
	}
	// The fields E10 rung 2 and 3 are built on. Missing any of them makes a rung
	// unreportable, so they are asserted rather than assumed.
	if rec.WarmAcquires+sumUint(rec.ColdAcquires) != 3 {
		t.Errorf("acquires = %d warm + %v cold, want 3 total", rec.WarmAcquires, rec.ColdAcquires)
	}
	// Only the RUN term is asserted nonzero, and only because the fake launcher really
	// shells out to `bash -c`, so it costs milliseconds on any machine. Acquire and
	// destroy do not: FakeLauncher.Restore is a map insert and the fake VM's Destroy is
	// bookkeeping, both well under a microsecond, so a p50 of 0 is the CORRECT reading on
	// a fast machine rather than a defect. This is the same reasoning the resume field
	// below already used, applied consistently -- asserting a duration is nonzero asserts
	// that the clock had resolution, not that the code works.
	if rec.P50RunUs == 0 {
		t.Errorf("record = %+v, want a measurable run term (the fake really runs bash)", rec)
	}
	for _, field := range []string{`"p50_acquire_us"`, `"p95_acquire_us"`, `"p50_destroy_us"`, `"p95_destroy_us"`} {
		if !strings.Contains(out, field) {
			t.Errorf("record missing %s — the hot path must be decomposed into acquire/run/destroy, out=%s", field, out)
		}
	}
	// Resume is a term too — on the Firecracker arm it performs the workspace
	// mount, exactly a cost this benchmark exists to expose. The fake's Resume is
	// a no-op so it may legitimately measure ~0us; what must hold is that the
	// field is present in the contract, not that it's nonzero.
	// Resume's sub-phases are asserted BY VALUE, not by key presence. A
	// strings.Contains on the tag is satisfied by Go marshalling a zero int64, so it
	// cannot tell a populated record from a ladder that reads mount_us=0 at every
	// rung -- which is the failure that would silently void the whole decomposition,
	// and which presence-only checks let through at two separate points (the sample
	// copy in runExecMode and the pct call in realMain).
	//
	// The presence-only justification above does NOT carry over to these three: they
	// are not clock-derived, so the fake cannot legitimately measure ~0. They come
	// from fakeHostVM.ResumePhases, which returns three DISTINCT canned durations, so
	// comparing against those also pins the slot ordering along the whole copy chain
	// (VM -> Phases -> sample -> runResult) -- a transposition of two same-typed
	// fields compiles silently and would relabel the mount as the dial.
	for _, tc := range []struct {
		name string
		got  int64
		want int64
	}{
		{"p50_vmresume_us", rec.P50VMResumeUs, vmpool.FakeVMResumeUs},
		{"p95_vmresume_us", rec.P95VMResumeUs, vmpool.FakeVMResumeUs},
		{"p50_vsockdial_us", rec.P50VsockDialUs, vmpool.FakeVsockDialUs},
		{"p95_vsockdial_us", rec.P95VsockDialUs, vmpool.FakeVsockDialUs},
		{"p50_mount_us", rec.P50MountUs, vmpool.FakeMountUs},
		{"p95_mount_us", rec.P95MountUs, vmpool.FakeMountUs},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %d, want %d — the value is not reaching the JSON record, so a ladder "+
				"would read this term as zero at every rung", tc.name, tc.got, tc.want)
		}
	}
	for _, f := range []string{
		// The tags themselves still have to appear, so a rename is caught as well as a
		// dropped value (the struct fields above would follow a rename silently).
		`"p50_vmresume_us"`, `"p95_vmresume_us"`,
		`"p50_vsockdial_us"`, `"p95_vsockdial_us"`,
		`"p50_mount_us"`, `"p95_mount_us"`,
	} {
		if !strings.Contains(out, f) {
			t.Errorf("record is missing %s: %s", f, out)
		}
	}
	if !strings.Contains(out, `"p50_resume_us"`) || !strings.Contains(out, `"p95_resume_us"`) {
		t.Errorf("record missing resume phase fields, out=%s", out)
	}
	if rec.VMM != "fake" {
		t.Errorf("VMM = %q, want fake — spec §6 requires the substrate recorded in every run record", rec.VMM)
	}
}

// TestAnUnquotedMultiWordCommandIsNotSilentlyTruncated guards against the worst
// defect this CLI could have: silently measuring a different, possibly no-op
// command while reporting a clean result. "-- echo hello world > out.txt" must run
// in full, not just "echo" — checked here by an observable side effect (a file
// written into the workspace), not just the exit status, because the broken
// version of this code also exits 0 with plausible timings.
func TestAnUnquotedMultiWordCommandIsNotSilentlyTruncated(t *testing.T) {
	dir := t.TempDir()
	out, err := run(t,
		"--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
		"--key=run-b", "--iterations=1", "--", "echo", "hello", "world", ">", "out.txt")
	if err != nil {
		t.Fatalf("realMain: %v (out=%s)", err, out)
	}
	got, err := os.ReadFile(filepath.Join(dir, "run-b", "out.txt"))
	if err != nil {
		t.Fatalf("workspace file missing — the command was truncated to its first word: %v", err)
	}
	if want := "hello world"; strings.TrimSpace(string(got)) != want {
		t.Fatalf("out.txt = %q, want %q", got, want)
	}
}

// TestStdinFlagReachesTheCommand proves --stdin's byte-level plumbing all the way
// down to the launcher, under --vmm=fake, with no /dev/kvm needed. The real payoff
// (guest agent's HasStdin-driven parked-vs-fresh-child choice, spec §5.4) only
// exists on a real launcher and cannot be exercised here — but the flag reaching
// vmpool.Exec.Stdin, which becomes vmpool.Command.Stdin (pool.go), which is what
// guestconn.go's HasStdin: len(c.Stdin) > 0 actually tests, is exactly the part
// this binary owns and can prove locally. E10's driver relies on an empty --stdin
// vs a non-empty one being the one knob that flips that boolean.
func TestStdinFlagReachesTheCommand(t *testing.T) {
	dir := t.TempDir()
	out, err := run(t,
		"--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
		"--key=run-stdin", "--iterations=1", "--stdin=hello-from-stdin",
		"--", "cat > out.txt")
	if err != nil {
		t.Fatalf("realMain: %v (out=%s)", err, out)
	}
	got, err := os.ReadFile(filepath.Join(dir, "run-stdin", "out.txt"))
	if err != nil {
		t.Fatalf("workspace file missing — --stdin never reached the command: %v", err)
	}
	if want := "hello-from-stdin"; string(got) != want {
		t.Fatalf("out.txt = %q, want %q", got, want)
	}
}

// TestStdinFlagDefaultsToEmpty guards the other half of TestStdinFlagReachesTheCommand:
// a run with no --stdin must not carry any (e.g. from a stale default), or a rung
// meant to price the parked-bash path (spec §5.4) would silently exercise the
// fresh-child path instead. `cat` with no stdin and stdin closed exits 0 with empty
// output; a nonzero exit or nonempty out.txt here would mean stdin leaked in.
func TestStdinFlagDefaultsToEmpty(t *testing.T) {
	dir := t.TempDir()
	out, err := run(t,
		"--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
		"--key=run-nostdin", "--iterations=1",
		"--", "cat > out.txt; wc -c < out.txt > count.txt")
	if err != nil {
		t.Fatalf("realMain: %v (out=%s)", err, out)
	}
	got, err := os.ReadFile(filepath.Join(dir, "run-nostdin", "count.txt"))
	if err != nil {
		t.Fatalf("workspace file missing: %v", err)
	}
	if want := "0"; strings.TrimSpace(string(got)) != want {
		t.Fatalf("count.txt = %q, want %q (no --stdin must mean no stdin bytes reach the command)", got, want)
	}
}

func TestRefusesAnEmptyKey(t *testing.T) {
	dir := t.TempDir()
	_, err := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir, "--key=", "--", "true")
	if err == nil {
		t.Fatal("realMain accepted an empty --key")
	}
	if !strings.Contains(err.Error(), "empty-workspace-key") {
		t.Fatalf("err = %v, want the empty-workspace-key refusal (spec §3.4)", err)
	}
}

func TestRefusesAnUnknownVMM(t *testing.T) {
	dir := t.TempDir()
	if _, err := run(t, "--vmm=qemu", "--snapshot-dir="+dir, "--workspace-root="+dir, "--key=k", "--", "true"); err == nil {
		t.Fatal("realMain accepted --vmm=qemu")
	}
}

func sumUint(m map[string]uint64) uint64 {
	var n uint64
	for _, v := range m {
		n += v
	}
	return n
}

func TestModeReplenishMeasuresRestoreOnly(t *testing.T) {
	dir := t.TempDir()
	out, err := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
		"--key=run-a", "--mode=replenish", "--iterations=4", "--warmup=1", "--json", "--", "true")
	if err != nil {
		t.Fatalf("realMain: %v (%s)", err, out)
	}
	var rec runResult
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &rec); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	// Rung 3 measures spawn -> restore -> pause -> ready, WALL AND CPU. Spec §7.2: "The
	// CPU number is what §7.3 divides into host capacity. Wall time alone misleads."
	// The acquire term is reported as a FIELD, not asserted nonzero: replenishment on the
	// fake launcher is a map insert, so its p50 legitimately rounds to 0us. What must hold
	// is that a replenishment rung is labelled as one and carries the phase it measures.
	if rec.Mode != "replenish" {
		t.Fatalf("Mode = %q, want replenish (rec = %+v)", rec.Mode, rec)
	}
	if !strings.Contains(out, `"p50_acquire_us"`) {
		t.Fatalf("replenish record missing p50_acquire_us, out=%s", out)
	}
	if rec.CPUChildUs < 0 {
		t.Fatalf("CPUChildUs = %d", rec.CPUChildUs)
	}
	// No command ran, so there is no run term to report — reporting one would invite
	// reading a replenishment rung as a hot-path rung.
	if rec.P50RunUs != 0 {
		t.Fatalf("P50RunUs = %d in replenish mode, want 0", rec.P50RunUs)
	}
	// Spec §7.5: "The first restore differs from the hundredth (page cache, THP,
	// fragmentation). Discard warmup, report steady state."
	if rec.WarmupDiscarded != 1 || rec.Iterations != 4 {
		t.Fatalf("rec = %+v, want 1 warmup discarded out of 4", rec)
	}
}

func TestModeTeardownVariantsAreDistinct(t *testing.T) {
	dir := t.TempDir()
	for _, mode := range []string{"teardown-inflight", "teardown-standby", "teardown-bulk"} {
		out, err := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
			"--key=run-a", "--mode="+mode, "--iterations=3", "--json", "--", "true")
		if err != nil {
			t.Fatalf("%s: %v (%s)", mode, err, out)
		}
		var rec runResult
		_ = json.Unmarshal([]byte(strings.TrimSpace(out)), &rec)
		// Spec §7.2 rung 4: three variants, because "the per-VM number does not predict"
		// the bulk reclaim the sweep actually performs.
		//
		// The MAGNITUDE of the destroy term is deliberately NOT asserted here. A fake
		// Destroy() returns in well under a microsecond, so p50 rounds to 0 on a fast
		// machine: the previous `rec.P50DestroyUs == 0` check failed 8 runs in 12 on an
		// idle laptop and would have flaked in CI. Asserting a duration is nonzero
		// asserts that the clock had resolution, not that the code under test works.
		// Real magnitudes come from the rig run; what this test can honestly establish
		// is the STRUCTURE of the record, which is timing-independent.
		if rec.Mode != mode {
			t.Fatalf("%s: Mode = %q, want %q (rec = %+v)", mode, rec.Mode, mode, rec)
		}
		// A teardown rung measures destroy, not run. If mode wiring regressed to exec,
		// a run term would appear here — which is what makes this assertion carry
		// weight rather than merely pass.
		if rec.P50RunUs != 0 {
			t.Fatalf("%s: P50RunUs = %d, want 0 — a teardown rung has no run term", mode, rec.P50RunUs)
		}
		// The destroy term IS the whole measurement in these modes, so total tracks it
		// at any clock resolution, including when both round to 0.
		if rec.P50TotalUs != rec.P50DestroyUs {
			t.Fatalf("%s: P50TotalUs = %d but P50DestroyUs = %d — destroy should be the whole term",
				mode, rec.P50TotalUs, rec.P50DestroyUs)
		}
		if rec.P50DestroyUs < 0 {
			t.Fatalf("%s: P50DestroyUs = %d, want >= 0", mode, rec.P50DestroyUs)
		}
	}
}

func TestUnknownModeIsRefused(t *testing.T) {
	dir := t.TempDir()
	// A typo in a mode name must be a refusal, not a plausible-looking result: every
	// percentile of an undispatched rung is 0, which reads exactly like a real rung
	// whose timings fell below clock resolution.
	out, err := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
		"--key=run-a", "--mode=teardown-inflght", "--iterations=3", "--json", "--", "true")
	if err == nil {
		t.Fatalf("a misspelled --mode was accepted and produced: %s", out)
	}
	// The message must name the offending value AND the accepted set — an error that
	// says only "invalid mode" makes the operator re-read the source to find the list.
	msg := err.Error()
	if !strings.Contains(msg, "teardown-inflght") || !strings.Contains(msg, "teardown-bulk") {
		t.Fatalf("error names neither the bad value nor the valid set: %v", err)
	}
}

func TestEveryValidModeIsDispatched(t *testing.T) {
	// The accepted-mode list and realMain's dispatch switch are two lists that must
	// agree, and nothing structural forces them to. A mode present in the validator but
	// absent from the dispatcher passes validation, falls through, and yields an
	// all-zeros record at exit 0. Running every accepted mode is what keeps them
	// agreeing; the dispatcher's default case is what makes a divergence loud.
	for _, mode := range []string{"exec", "replenish", "teardown-inflight", "teardown-standby", "teardown-bulk"} {
		dir := t.TempDir()
		out, err := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
			"--key=run-a", "--mode="+mode, "--iterations=2", "--json", "--", "true")
		if err != nil && strings.Contains(err.Error(), "diverged") {
			t.Fatalf("%s is accepted by the validator but not dispatched: %v", mode, err)
		}
		if err != nil {
			t.Fatalf("%s: %v (%s)", mode, err, out)
		}
	}
}

func TestEveryRecordCarriesItsSubstrate(t *testing.T) {
	dir := t.TempDir()
	out, _ := run(t, "--vmm=fake", "--snapshot-dir="+dir, "--workspace-root="+dir,
		"--key=run-a", "--substrate=nested-c8i", "--json", "--", "true")
	var rec runResult
	_ = json.Unmarshal([]byte(strings.TrimSpace(out)), &rec)
	// Spec §6: "Nested-virt vs metal divergence — Record the substrate in every run
	// record." A rung whose substrate is unknown cannot be compared to any other.
	if rec.Substrate != "nested-c8i" {
		t.Fatalf("Substrate = %q", rec.Substrate)
	}
	// Spec §7.5: raise and record the kernel limits, because they "fail at 500 VMs after
	// working at 20, indistinguishably from a real ceiling".
	for _, k := range []string{"RLIMIT_MEMLOCK", "RLIMIT_NOFILE", "vm.max_map_count", "pid_max"} {
		if _, ok := rec.Limits[k]; !ok {
			t.Errorf("Limits is missing %s: %v", k, rec.Limits)
		}
	}
}
