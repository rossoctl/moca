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
	"math"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/rossoctl/moca/remote-worker/internal/guestagent"
)

func main() {
	// Lease mode re-executes this binary (/proc/self/exe) as the per-Exec shim that
	// drops to the exec uid. That invocation is not the agent and carries no agent
	// flags, so it is dispatched before flag.Parse; ShimMain never returns.
	if len(os.Args) > 1 && os.Args[1] == guestagent.ShimArg {
		guestagent.ShimMain(os.Args[2:])
	}

	var (
		listenAddr = flag.String("listen", "vsock:1024", "vsock:<port>, or unix:<path> for local development")
		workDir    = flag.String("workdir", "/workspace", "the mounted workspace; every command's cwd")
		scratchDir = flag.String("scratch", "/tmp/guest-agent", "guest tmpfs for staged command files")
		shell      = flag.String("shell", "bash", "shell to park")

		egressListen = flag.String("egress-listen", "", "loopback host:port for the egress forwarder (e.g. 127.0.0.1:3128); empty disables")
		egressPort   = flag.Uint("egress-vsock-port", 1025, "host vsock port (CID 2) the egress forwarder splices to")

		leaseCgroupRoot = flag.String("lease-cgroup-root", "", "cgroup2 directory under which each lease Exec gets its own cgroup; empty disables lease mode")
		leaseUID        = flag.Int("lease-uid", 7000, "uid a lease Exec runs as")
		leaseGID        = flag.Int("lease-gid", 7000, "gid a lease Exec runs as")
		leaseHome       = flag.String("lease-home", "/tmp/sbx-home", "HOME of the lease exec identity; created at startup")
		leaseTrackedUID = flag.Int("lease-tracked-uid-base", guestagent.DefaultTrackedUIDBase, "first uid of the tracked-process range; each tracked process runs under its own uid (0 means the default)")
		leaseTrackedN   = flag.Int("lease-tracked-uids", guestagent.DefaultMaxTrackedUIDs, "how many uids the tracked-process range holds (0 means the default; the range cannot be turned off)")
	)
	flag.Parse()

	if err := os.MkdirAll(*scratchDir, 0o700); err != nil {
		log.Fatalf("guest-agent: scratch %s: %v", *scratchDir, err)
	}
	agent, err := guestagent.NewAgent(guestagent.AgentOptions{
		Shell: *shell, WorkDir: *workDir, ScratchDir: *scratchDir,
		// With a cgroup root set, NewAgent prepares lease mode (cgroup root, HOME) and
		// fails here, at boot, if it cannot: the snapshot build then never sees an agent.
		Lease: guestagent.LeaseOptions{
			CgroupRoot: *leaseCgroupRoot, UID: *leaseUID, GID: *leaseGID, Home: *leaseHome,
			TrackedUIDBase: *leaseTrackedUID, MaxTrackedUIDs: *leaseTrackedN,
		},
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

	if *egressListen != "" {
		// A configured egress that cannot bind is a broken image; fail loudly so the
		// snapshot build probe catches it.
		if err := guestagent.BringUpLoopback(); err != nil {
			log.Fatalf("guest-agent: egress: %v", err)
		}
		eln, err := net.Listen("tcp", *egressListen)
		if err != nil {
			log.Fatalf("guest-agent: egress listen %s: %v", *egressListen, err)
		}
		defer eln.Close()
		if *egressPort == 0 || uint64(*egressPort) > math.MaxUint32 {
			log.Fatalf("guest-agent: -egress-vsock-port %d out of range 1..%d", *egressPort, uint32(math.MaxUint32))
		}
		port := uint32(*egressPort)
		fwd := &guestagent.EgressForwarder{
			Dial: func() (net.Conn, error) { return guestagent.DialVsock(2, port) },
		}
		go func() {
			// PID 1: a forwarder failure after startup is logged, never fatal.
			log.Printf("guest-agent: egress forwarder stopped: %v", fwd.Serve(eln))
		}()
		log.Printf("guest-agent: egress %s -> vsock 2:%d", *egressListen, port)
	}

	ln, err := guestagent.Listen(*listenAddr)
	if err != nil {
		log.Fatalf("guest-agent: listen %s: %v", *listenAddr, err)
	}
	defer ln.Close()
	log.Printf("guest-agent: parked in accept() on %s, shell pid %d", *listenAddr, agent.ShellPID())
	// Blocking here is the state the snapshot captures.
	log.Fatalf("guest-agent: serve: %v", agent.Serve(ln))
}
