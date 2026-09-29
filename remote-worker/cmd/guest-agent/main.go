// Command guest-agent runs INSIDE the microVM. It is the static binary the golden
// snapshot captures blocked in vsock accept() (spec §5.1, §5.2).
//
// It holds no credentials by construction, and that is an invariant rather than an
// observation: Firecracker documents resuming one snapshot more than once as
// INSECURE, because IDs, RNG seeds, entropy pools and tokens are duplicated. We use
// that pattern knowingly, so nothing secret or unique may exist in the golden
// snapshot — all per-run identity arrives after resume, the workspace via a per-VM
// mount and the command over vsock. SANDBOX_TOKEN lives in the worker on the host and
// never in a guest (spec §5.2). §8's "snapshot holds no secrets" gate pins it.
package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/rossoctl/moca/remote-worker/internal/guestagent"
)

func main() {
	var (
		listenAddr = flag.String("listen", "vsock:1024", "vsock:<port>, or unix:<path> for local development")
		workDir    = flag.String("workdir", "/workspace", "the mounted workspace; every command's cwd")
		scratchDir = flag.String("scratch", "/tmp/guest-agent", "guest tmpfs for staged command files")
		shell      = flag.String("shell", "bash", "shell to park")
	)
	flag.Parse()

	if err := os.MkdirAll(*scratchDir, 0o700); err != nil {
		log.Fatalf("guest-agent: scratch %s: %v", *scratchDir, err)
	}
	agent, err := guestagent.NewAgent(guestagent.AgentOptions{
		Shell: *shell, WorkDir: *workDir, ScratchDir: *scratchDir,
	})
	if err != nil {
		log.Fatalf("guest-agent: %v", err)
	}
	defer agent.Close()

	// A command containing `kill $PPID`, or the common defensive idiom
	// `trap 'kill $PPID' EXIT`, signals THIS process rather than the parked shell:
	// bash does not recompute $ or $PPID inside the "( ... )" subshell
	// runOnParkedShell sources commands in — only $BASHPID differs there — so $PPID
	// inside it is the parked shell's parent, which is this guest-agent process.
	//
	// Ignoring the terminating signals defends the ACCIDENTAL case: a well-meaning
	// trap idiom would otherwise kill the agent and surface as a short-response
	// connection error instead of the command's own exit code. It does NOT, and
	// cannot in principle, defend against a DELIBERATE kill -9 (SIGKILL cannot be
	// ignored), nor against any other deliberate action by guest-root code — guest
	// code is root inside its own VM and can pkill this process regardless of
	// $PPID, so the quirk grants a malicious command no new capability. The
	// containment this design actually relies on is the hypervisor boundary and the
	// host destroying the VM after every command, not this process defending
	// itself.
	signal.Ignore(syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)

	ln, err := guestagent.Listen(*listenAddr)
	if err != nil {
		log.Fatalf("guest-agent: listen %s: %v", *listenAddr, err)
	}
	defer ln.Close()
	log.Printf("guest-agent: parked in accept() on %s, shell pid %d", *listenAddr, agent.ShellPID())
	// Blocking here is the state the snapshot captures.
	log.Fatalf("guest-agent: serve: %v", agent.Serve(ln))
}
