package vmpool

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// WHAT CI ACTUALLY ENFORCES ABOUT SPEC §8, WRITTEN DOWN WHERE A READER WILL SEE IT.
//
// Six of §8's gates — the ones that ARE the isolation argument for this tier — need
// /dev/kvm and a golden snapshot built by deploy/microvm/build-snapshot.sh. Standard
// GitHub runners have neither: no nested virtualisation, and the snapshot is a multi-GiB
// artefact built on the instance generation that will restore it (spec §2.4 requires
// identical hardware, so it cannot be a cached CI blob either). They therefore CANNOT be
// switched on in CI, and until this file existed nothing in the tree said so: every
// automated run skipped them silently and appeared green, which reads as "the gates pass".
//
// So the honest arrangement, in three parts:
//
//  1. The gates that need no hardware run on every PR — CI's `microvm-gates` job runs
//     them with -v so each one is named in the log, and fails if the set that ran is
//     empty.
//  2. The gates that need a rig run from .github/workflows/microvm-kvm-gates.yml, a
//     manual (workflow_dispatch) job that sets SH_KVM=1 on a KVM-capable runner. It is
//     opt-in because there is no such runner in this repository's fleet; what it does is
//     make the command reproducible and the prerequisite explicit rather than tribal.
//  3. This test, which fails if the classification below stops matching the code. A gate
//     that quietly acquires requireKVM, or a new §8 gate nobody classified, would
//     otherwise slip from column 1 to column 2 with no reader the wiser — the exact
//     failure mode of the original gap.
//
// TestTheGateInventoryMatchesTheCode is the drift check; TestTheCIWorkflowsRunTheGates
// pins that (1) and (2) still exist.

// ciCoveredGates run on every PR. The value says why the gate needs no hardware — a gate
// listed here that in fact needs a VM would be a false claim of coverage, which is the
// dangerous direction, so the AST check below verifies each one really is unconditional.
var ciCoveredGates = map[string]string{
	"TestGateEmptyKeyIsRefused":                     "the refusal happens before Acquire ever calls the launcher; asserted against the fake",
	"TestGateParkedThenResumed":                     "parking/resume bookkeeping is the Pool's own, exercised against the fake launcher and clock",
	"TestGateReclaimThenRedispatch":                 "Reclaim's contract and re-derivation are Pool-level; the fake launcher is enough",
	"TestGateReclamationCannotDeleteALiveWorkspace": "the sweep-versus-re-created-key window is Pool bookkeeping plus real directories",
	"TestGateEgressStandbyFailsClosed":              "Restore's Register failure path runs against a fake jailer script and a fake binder; no VM is needed",
	"TestGateEgressTeardownOrdering":                "the SIGKILL, Unregister, unlink order is checked on a real sleep process and a real unix socket; no VM is needed",
}

// partiallyCoveredGates have a half that runs everywhere and a half that needs a rig. The
// value names which is which, because "TestGateNoVMReuse passed" means materially
// different things in CI and on the rig.
var partiallyCoveredGates = map[string]string{
	"TestGateNoVMReuse": "fake_launcher_concurrency runs in CI (N goroutines, M keys, fakeVM.Run's own single-Run guard); real_launcher needs the rig",
}

// manualOnlyGates do not run in CI at all. The value is the prerequisite, so a reader
// knows what it would take to run one rather than only that it did not run.
var manualOnlyGates = map[string]string{
	"TestGateWriteDurability":           "a write in Exec N must survive into Exec N+1 — needs a real guest to have a page cache to lose; /dev/kvm + golden snapshot",
	"TestGateNoCrossRunBleed":           "two interleaved keys against real guests; /dev/kvm + golden snapshot. THE property this tier exists for (spec §2.3)",
	"TestGateSnapshotHoldsNoSecrets":    "greps the golden memfile and reads the guest's env; needs the snapshot on disk, and SANDBOX_TOKEN forwarded for its live-token half",
	"TestGateNoNetworkDevice":           "reads /sys/class/net, resolv.conf, a direct dial and the env of a restored guest (P4.1 T7); /dev/kvm + golden snapshot built with the egress init",
	"TestGateEgressThroughVsock":        "real guest -> vsock 1025 -> in-process moca-egress -> host upstream; /dev/kvm + a snapshot built with Task 6's init",
	"TestGateCredentialNeverInGuest":    "real guest -> in-process moca-egress with a fake control plane; scans the guest's files, environ and memory for the fixture credential; /dev/kvm + a snapshot built with --egress-ca, SH_EGRESS_CA_CERT and SH_EGRESS_CA_KEY",
	"TestGateLeakFreeTeardown":          "counts pids in the VM cgroup slice against a wall-clock bound; needs real VMMs under /sys/fs/cgroup",
	"TestGateClock":                     "reads the guest's own `date +%s`; only a restored snapshot can have a stale clock to catch",
	"TestGateOutputCapAtSource":         "16 MiB of guest stdout against the 8 MiB cap, including the wall-time signature of capping in the guest",
	"TestGateLeaseExecKillsProcesses":   "a real lease-v1 guest; /dev/kvm + a golden snapshot built by Task 5's build-snapshot.sh; its level2 subtest also needs lease-processes-v1 in the snapshot (plan 5) and skips, NOT RUN, without it; process_start survivors (a tracked process and its child) are the only ones",
	"TestGateLeaseFreshShell":           "a real lease-v1 guest; /dev/kvm + a golden snapshot built by Task 5's build-snapshot.sh",
	"TestGateLeasePrivilege":            "a real lease-v1 guest; /dev/kvm + a golden snapshot built by Task 5's build-snapshot.sh; its level2 subtest also needs lease-processes-v1 in the snapshot (plan 5) and skips, NOT RUN, without it; the tracked half (Review Focus 2): ptrace, process_vm_writev, /proc/<pid>/mem and signals from an Exec to a tracked process all fail",
	"TestGateLeaseOneSandbox":           "the pool's lease path over a real lease-v1 guest, VMs in a gate-private pooled cgroup; /dev/kvm + a lease-v1 snapshot, run as root on cgroup v2",
	"TestGateLeaseTeardown":             "the pool's lease path over a real lease-v1 guest, VMs in a gate-private pooled cgroup; /dev/kvm + a lease-v1 snapshot, run as root on cgroup v2; checks the lease cgroup, jail, sockets, VMM process and host taps after every drivable end reason",
	"TestGateLeaseStaleEpoch":           "the pool's lease path over a real lease-v1 guest, VMs in a gate-private pooled cgroup; /dev/kvm + a lease-v1 snapshot, run as root on cgroup v2; restarts the pool with the state file deleted; its level2 subtest also needs lease-processes-v1 in the snapshot (plan 5) and skips, NOT RUN, without it; a downgrade to lease stops the tracked processes and keeps the lease",
	"TestGateLeaseOwnership":            "the pool's lease path over a real lease-v1 guest, VMs in a gate-private pooled cgroup; /dev/kvm + a lease-v1 snapshot, run as root on cgroup v2; root writes through a per-Exec VM, then a lease Exec as uid 7000 modifies it",
	"TestGateLeaseNotice":               "the pool's lease path over a real lease-v1 guest, VMs in a gate-private pooled cgroup; /dev/kvm + a lease-v1 snapshot, run as root on cgroup v2; the pending event after every drivable end reason; its level2 subtest also needs lease-processes-v1 in the snapshot (plan 5) and skips, NOT RUN, without it; every end lists the tracked processes it stopped",
	"TestGateLeaseReclaim":              "the pool's lease path over a real lease-v1 guest, VMs in a gate-private pooled cgroup; /dev/kvm + a lease-v1 snapshot, run as root on cgroup v2; measured lease charges under a squeezed budget",
	"TestGateLeaseSecrets":              "the pool's lease path over a real lease-v1 guest, VMs in a gate-private pooled cgroup; /dev/kvm + a lease-v1 snapshot, run as root on cgroup v2; reads the guest's RAM from the host through the VMM's /proc/<pid>/mem, SANDBOX_TOKEN forwarded for its live-token half",
	"TestGateLeaseFreePageReporting":    "the pool's lease path over a real lease-v1 guest, VMs in a gate-private pooled cgroup; /dev/kvm + a lease-v1 snapshot, run as root on cgroup v2; a snapshot with balloon-fpr-v1, and the memfile mlocked as the worker does",
	"TestGateLeaseExecCaps":             "the pool's lease path over a real lease-v1 guest, VMs in a gate-private pooled cgroup; /dev/kvm + a lease-v1 snapshot, run as root on cgroup v2; a fork bomb, an OOM, and tmpfs left by one Exec under the next's allocation, against the guest agent's Exec cgroup caps and the cgroup root's",
	"TestGateLeaseTimeoutKeepsTheLease": "the pool's lease path over a real lease-v1 guest, VMs in a gate-private pooled cgroup; /dev/kvm + a lease-v1 snapshot, run as root on cgroup v2; the guest's own timeout kills the Exec and the lease is kept",
	"TestGateLeaseProcessLifecycle":     "the pool's level-2 lease path over a real guest, VMs in a gate-private pooled cgroup; /dev/kvm + a snapshot with lease-v1 and lease-processes-v1 (plan 5; skips, NOT RUN, without it), run as root on cgroup v2; start, list, logs, stop, TERM then KILL, the 4 MiB ring, MAX 4, 8 exited kept, uid reuse and a tracked OOM",
}

// gateCoverage is how a gate is gated, as the code says rather than as a map claims.
type gateCoverage string

const (
	coverageCI      gateCoverage = "ci"
	coveragePartial gateCoverage = "partial"
	coverageManual  gateCoverage = "manual"
)

// classifyGate reports how fn is gated: requireKVM as a statement of the function's own
// body means the whole gate is manual; requireKVM only inside a nested closure (a t.Run
// subtest) means part of it still runs; neither means it runs everywhere.
func classifyGate(fn *ast.FuncDecl) gateCoverage {
	callsRequireKVM := func(st ast.Stmt) bool {
		es, ok := st.(*ast.ExprStmt)
		if !ok {
			return false
		}
		call, ok := es.X.(*ast.CallExpr)
		if !ok {
			return false
		}
		id, ok := call.Fun.(*ast.Ident)
		return ok && id.Name == "requireKVM"
	}
	for _, st := range fn.Body.List {
		if callsRequireKVM(st) {
			return coverageManual
		}
	}
	nested := false
	ast.Inspect(fn, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok && id.Name == "requireKVM" {
			nested = true
		}
		return !nested
	})
	if nested {
		return coveragePartial
	}
	return coverageCI
}

// TestTheGateInventoryMatchesTheCode is the drift check on the three maps above.
func TestTheGateInventoryMatchesTheCode(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package directory: %v", err)
	}
	fset := token.NewFileSet()
	actual := map[string]gateCoverage{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, e.Name(), nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", e.Name(), err)
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv != nil || fn.Body == nil || !strings.HasPrefix(fn.Name.Name, "TestGate") {
				continue
			}
			actual[fn.Name.Name] = classifyGate(fn)
		}
	}
	if len(actual) == 0 {
		t.Fatal("found no TestGate* functions at all — this inventory would then be asserting nothing; if the gates were renamed, update the prefix here deliberately")
	}

	declared := map[string]gateCoverage{}
	for _, pair := range []struct {
		m map[string]string
		c gateCoverage
	}{
		{ciCoveredGates, coverageCI},
		{partiallyCoveredGates, coveragePartial},
		{manualOnlyGates, coverageManual},
	} {
		for name, reason := range pair.m {
			if reason == "" {
				t.Errorf("%s is declared %s with no reason — the reason is the part a reader needs", name, pair.c)
			}
			if prev, dup := declared[name]; dup {
				t.Errorf("%s is declared both %s and %s", name, prev, pair.c)
			}
			declared[name] = pair.c
		}
	}

	for _, name := range sortedKeys(actual) {
		want, ok := declared[name]
		if !ok {
			t.Errorf("gate %s is not in the inventory: classify it in ciCoveredGates, "+
				"partiallyCoveredGates or manualOnlyGates. A §8 gate nobody classified is how "+
				"six of them came to run nowhere while looking green.", name)
			continue
		}
		if got := actual[name]; got != want {
			t.Errorf("gate %s is declared %q but the code makes it %q — if this moved from "+
				"%q to %q, CI's coverage of §8 changed and the inventory must say so",
				name, want, got, want, got)
		}
	}
	for _, name := range sortedKeys(declared) {
		if _, ok := actual[name]; !ok {
			t.Errorf("the inventory lists %s, which no longer exists — a stale entry makes the "+
				"inventory read as more coverage than there is", name)
		}
	}

	// The counts, in the log, so a -v run states the gap rather than leaving it to be
	// inferred from a wall of SKIP lines.
	t.Logf("spec §8 gates: %d run in CI, %d partly, %d only on a KVM rig (see manualOnlyGates)",
		len(ciCoveredGates), len(partiallyCoveredGates), len(manualOnlyGates))
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// TestTheCIWorkflowsRunTheGates pins the wiring the inventory above describes. Without
// it, the inventory documents an arrangement that a workflow edit could quietly remove —
// and "the gates run in CI" would go back to being a claim with nothing behind it.
//
// It asserts the existence of the two jobs and the shape of what they run, not their full
// YAML: a brittle assertion here would be edited away rather than satisfied.
func TestTheCIWorkflowsRunTheGates(t *testing.T) {
	// From remote-worker/internal/vmpool up to the repository root.
	root := filepath.Join("..", "..", "..")
	for _, want := range []struct {
		path     string
		contains []string
		why      string
	}{
		{
			path:     filepath.Join(root, ".github", "workflows", "ci.yml"),
			contains: []string{"microvm-gates:", "TestGate", "TestShim"},
			why:      "the job that runs the hardware-free §8 gates on every PR",
		},
		{
			path:     filepath.Join(root, ".github", "workflows", "microvm-kvm-gates.yml"),
			contains: []string{"workflow_dispatch:", "SH_KVM", "SH_VMM"},
			why:      "the manual rig job that is the ONLY thing that runs the KVM-gated gates",
		},
	} {
		b, err := os.ReadFile(want.path)
		if err != nil {
			t.Errorf("reading %s (%s): %v", want.path, want.why, err)
			continue
		}
		for _, needle := range want.contains {
			if !strings.Contains(string(b), needle) {
				t.Errorf("%s no longer mentions %q — %s", want.path, needle, want.why)
			}
		}
	}
}
