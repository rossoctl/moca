package vmpool

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// Spec §8's last gate: "Nothing executes outside a VM — §3.5's privilege property: no
// `bash` child of microvm-worker on any code path."
//
// A runtime test cannot prove a NEGATIVE over all code paths, so this is a static one:
// no file reachable from microvm-worker may spawn a process, with the deliberate
// exceptions named below. That is a stronger claim than any single execution, and it is
// the claim §3.5's whole privilege argument rests on — the privileged process only
// parses a frame, writes bytes to a vsock, and spawns a VMM with fixed argv.
//
// Final review M1 found this pin blind in two directions, and both are fixed here:
//
//   - It keyed detection on the literal identifier `exec`, while FOUR non-test files in
//     the very package it scanned import os/exec as `osexec` — the package's dominant
//     local convention (launcher_chv_unix.go, launcher_chv_other.go,
//     launcher_firecracker_unix.go, launcher_firecracker_other.go, plus
//     internal/exec/runner_unix.go and runner_other.go). An `osexec.Command("bash", …)`
//     in any of them, or in a new file following their convention, passed the gate. The
//     import name is now RESOLVED from each file's own AST, so whatever a file calls the
//     package is what the walk looks for — including a dot-import, which turns the call
//     into a bare identifier and is refused outright rather than silently unseen.
//   - It scanned only os.ReadDir(".") — the vmpool package directory — while
//     `go list -deps ./cmd/microvm-worker` includes internal/exec (whose runner.go
//     spawns bash) and internal/guestagent (whose agent.go spawns the guest shell).
//     Neither was scanned. All four packages in the worker's own module closure are now
//     covered, and the two spawn sites are declared, with reasons, in scannedPackages.
//
// And the pin now proves it FIRES: TestTheSpawnDetectorFiresOnEveryAliasSpelling plants
// violations in synthetic sources and asserts each is flagged. An absence-assertion that
// has never been shown to be capable of failing is asserting nothing — the rule this
// branch adopted after its own history of vacuous tests.

// scannedPackages lists every package in cmd/microvm-worker's module-local dependency
// closure (`go list -deps ./cmd/microvm-worker`, filtered to this module), with the files
// in each that are ALLOWED to spawn and why. A package missing from this map is a package
// this gate does not cover, which is how M1's second half happened; a file missing from a
// package's allow map must not spawn at all.
var scannedPackages = map[string]map[string]string{
	".": { // internal/vmpool — this package
		"testlauncher.go":         "vmpoolctl-only host fake; microvm-worker's launcherFor refuses it (TestThereIsNoHostFallbackLauncher)",
		"launcher_firecracker.go": "spawns the jailer with fixed argv (§3.5)",
		"launcher_chv.go":         "spawns cloud-hypervisor, virtiofsd and systemd-run with fixed argv (§3.5)",
	},
	"../exec": { // internal/exec
		// In the closure only because vmpool.Runner (runner.go) adapts to this
		// package's wexec.Runner seam — a type dependency, not a call path.
		// microvm-worker never constructs BashRunner; that is not a promise here, it is
		// asserted by TestMicrovmWorkerNeverConstructsTheHostBashRunner below.
		"runner.go": "the CONTAINER arm's BashRunner (`bash -c`); reachable from cmd/worker, never from cmd/microvm-worker",
	},
	"../guestagent": { // internal/guestagent
		// This code runs INSIDE the guest VM (cmd/guest-agent, baked into the golden
		// snapshot's rootfs). §3.5's property is about the privileged HOST worker: a
		// shell in the guest is the entire point of the tier.
		"agent.go":            "runs inside the guest VM, not on the host — spawning the guest shell is the tier's purpose (§3.5 constrains the host worker)",
		"lease_shim_linux.go": "runs inside the guest VM: the lease shim drops to the exec uid, then execs the Exec's argv (§3.5 constrains the host worker)",
		"lease_linux.go":      "runs inside the guest VM: the lease exec path forks the shim into the Exec's cgroup (§3.5 constrains the host worker)",
		"tracked_linux.go":    "runs inside the guest VM: process_start forks the shim into the tracked process's cgroup (§3.5 constrains the host worker)",
	},
	"../session": {}, // internal/session — nothing here may spawn
}

func TestNothingInTheWorkerPathSpawnsAShell(t *testing.T) {
	for dir, allowed := range scannedPackages {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("reading scanned package %s: %v — if a package moved, update scannedPackages; do not drop it", dir, err)
		}
		for _, e := range entries {
			name := e.Name()
			if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			if _, ok := allowed[name]; ok {
				continue
			}
			path := filepath.Join(dir, name)
			src, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("reading %s: %v", path, err)
			}
			for _, finding := range spawnCallsIn(t, path, string(src)) {
				t.Errorf("%s: %s — §3.5's privilege property is that nothing agent-influenced "+
					"executes outside a VM. If this is a fixed-argv VMM spawn, add the file to "+
					"scannedPackages[%q] WITH its reason.", path, finding, dir)
			}
		}
	}
}

// spawnCallsIn reports every process-spawning call in one Go source, resolving the local
// name of the os/exec import from the file's OWN import declarations rather than assuming
// it is called "exec".
func spawnCallsIn(t *testing.T, filename, src string) []string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filename, src, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", filename, err)
	}

	// Local names bound to os/exec in THIS file. `exec "os/exec"`, `osexec "os/exec"` and
	// a bare `"os/exec"` all land here; `_ "os/exec"` cannot be called through, and
	// `. "os/exec"` is handled separately below because it produces no selector at all.
	execNames := map[string]bool{}
	dotImported := false
	for _, imp := range f.Imports {
		p, err := strconv.Unquote(imp.Path.Value)
		if err != nil || p != "os/exec" {
			continue
		}
		switch {
		case imp.Name == nil:
			execNames["exec"] = true // the package's own name
		case imp.Name.Name == ".":
			dotImported = true
		case imp.Name.Name == "_":
			// Imported for side effects only; nothing can be called through it.
		default:
			execNames[imp.Name.Name] = true
		}
	}

	// A dot-import makes exec.Command spell as a bare `Command(...)`, indistinguishable
	// from any local function of that name. Rather than guess, refuse the import itself:
	// nothing in this closure needs it, and allowing it would leave a spelling this
	// detector structurally cannot see — exactly M1's failure mode with a different name.
	if dotImported {
		return []string{`dot-imports "os/exec", which makes spawn calls unspellable to this gate`}
	}

	var found []string
	spawners := map[string]bool{"Command": true, "CommandContext": true}
	ast.Inspect(f, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		pkg, ok := sel.X.(*ast.Ident)
		if !ok {
			return true
		}
		if execNames[pkg.Name] && spawners[sel.Sel.Name] {
			found = append(found, fmt.Sprintf("spawns a process (%s.%s at line %d)",
				pkg.Name, sel.Sel.Name, fset.Position(sel.Pos()).Line))
			return true
		}
		// os.StartProcess / syscall.Exec|ForkExec|StartProcess are the same capability
		// under other names. None exists anywhere in this closure today; catching them
		// here means adding one is a red test rather than a quiet bypass of a gate whose
		// stated claim is "on any code path".
		if (pkg.Name == "os" && sel.Sel.Name == "StartProcess") ||
			(pkg.Name == "syscall" && (sel.Sel.Name == "Exec" || sel.Sel.Name == "ForkExec" || sel.Sel.Name == "StartProcess")) {
			found = append(found, fmt.Sprintf("spawns a process (%s.%s at line %d)",
				pkg.Name, sel.Sel.Name, fset.Position(sel.Pos()).Line))
		}
		return true
	})
	sort.Strings(found)
	return found
}

// TestTheSpawnDetectorFiresOnEveryAliasSpelling is the non-vacuousness proof M1 asked
// for. The gate above asserts an ABSENCE across four packages; per this branch's rule, a
// test for an absence must first show the presence is detectable. Each source below is a
// planted violation, and the alias case is the exact one that passed the pre-M1 gate: a
// file in internal/vmpool spawning host bash through the package's own dominant `osexec`
// convention.
func TestTheSpawnDetectorFiresOnEveryAliasSpelling(t *testing.T) {
	violations := map[string]string{
		"plain import": `package vmpool
import "os/exec"
func pwn() { _ = exec.Command("bash", "-c", "echo pwned") }`,

		"osexec alias (the M1 gap: the dominant convention in this very package)": `package vmpool
import osexec "os/exec"
func pwn() { _ = osexec.Command("bash", "-c", "echo pwned") }`,

		"an arbitrary alias nobody has used yet": `package vmpool
import shell "os/exec"
func pwn() { _ = shell.CommandContext(nil, "bash", "-c", "echo pwned") }`,

		"dot import (unspellable, so refused at the import)": `package vmpool
import . "os/exec"
func pwn() { _ = Command("bash", "-c", "echo pwned") }`,

		"os.StartProcess, the same capability under another name": `package vmpool
import "os"
func pwn() { _, _ = os.StartProcess("/bin/bash", nil, nil) }`,

		"syscall.ForkExec": `package vmpool
import "syscall"
func pwn() { _, _ = syscall.ForkExec("/bin/bash", nil, nil) }`,
	}
	for name, src := range violations {
		if got := spawnCallsIn(t, "zzplanted.go", src); len(got) == 0 {
			t.Errorf("the detector did NOT flag the planted violation %q — the gate is asserting nothing for this spelling", name)
		}
	}

	// The complement, so the detector is not merely flagging everything: a file that
	// imports os/exec and only handles an *exec.Cmd — which is precisely what the four
	// aliased files in this package legitimately do — must NOT be flagged.
	clean := `package vmpool
import osexec "os/exec"
func isolate(cmd *osexec.Cmd) { _ = cmd }
func alsoFine() { _ = osexec.ErrNotFound }`
	if got := spawnCallsIn(t, "zzclean.go", clean); len(got) != 0 {
		t.Errorf("the detector flagged a file that only handles an *exec.Cmd: %v — it would force every launcher helper into the allow map and the gate would stop meaning anything", got)
	}
}

// TestMicrovmWorkerNeverConstructsTheHostBashRunner turns scannedPackages' reason for
// allowing internal/exec/runner.go from a claim into an assertion. internal/exec is in
// cmd/microvm-worker's dependency closure only because vmpool.Runner adapts to its
// wexec.Runner seam; the host `bash -c` runner in it is the CONTAINER arm's, wired by
// cmd/worker. If microvm-worker ever named it, the allow map's reason would be false and
// the privilege gate would be excusing a live host-execution path.
func TestMicrovmWorkerNeverConstructsTheHostBashRunner(t *testing.T) {
	dir := "../../cmd/microvm-worker"
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading %s: %v", dir, err)
	}
	scanned := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		scanned++
		src, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		if strings.Contains(string(src), "BashRunner") {
			t.Errorf("%s/%s names BashRunner — microvm-worker must wire vmpool.Runner only; "+
				"scannedPackages' reason for allowing internal/exec/runner.go depends on this",
				dir, name)
		}
		// And nothing in the binary's own package may spawn either.
		for _, finding := range spawnCallsIn(t, name, string(src)) {
			t.Errorf("%s/%s: %s — the worker binary itself must spawn nothing but a VMM via a launcher", dir, name, finding)
		}
	}
	if scanned == 0 {
		t.Fatal("scanned no files in cmd/microvm-worker — this test would pass vacuously")
	}
}

// The complement: the host-bash fake must never be reachable from the worker. Its own
// test asserts launcherFor refuses it; this asserts the sentinel Kind cannot satisfy a
// Config built for a real arm, so even a wiring mistake fails at New rather than at
// runtime.
func TestTheHostFakeCannotServeARealVMMConfig(t *testing.T) {
	lc := NewFakeLauncher()
	for _, kind := range []VMMKind{Firecracker, CloudHypervisor} {
		_, err := New(Config{
			VMM: kind, SnapshotDir: t.TempDir(), WorkspaceRoot: t.TempDir(),
			MaxRuns: 4, MaxCommittedBytes: 1 << 30,
		}, lc, newFakeClock())
		if err == nil {
			t.Fatalf("New accepted the host fake for VMM=%q", kind)
		}
	}
}
