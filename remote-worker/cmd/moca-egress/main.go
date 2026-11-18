//go:build unix

// Command moca-egress is the host-side forward proxy for microVM guests.
// Config comes from MOCA_EGRESS_* environment variables; audit JSON goes to
// stdout and logs to stderr.
package main

import (
	"context"
	"fmt"
	"log"
	"net/netip"
	"os"
	"os/signal"
	"syscall"

	"github.com/rossoctl/moca/remote-worker/internal/egress"
	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
)

// checkLocalAddrs runs the host-address lookup once so a sandbox that blocks it
// (no AF_NETLINK) fails at boot instead of refusing every request.
func checkLocalAddrs(fn func() ([]netip.Addr, error)) error {
	if fn == nil {
		return nil
	}
	if _, err := fn(); err != nil {
		return fmt.Errorf("cannot read host addresses (needed for the private-destination check; is AF_NETLINK allowed?): %w", err)
	}
	return nil
}

func main() {
	// Installed first, so a SIGTERM that lands during setup (systemd stopping a unit that is
	// still starting) is caught here and handled as a clean stop rather than killing the
	// process with the default action halfway through binding the control socket.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	cfg, cc, err := egress.ConfigFromEnv(os.Getenv)
	if err != nil {
		log.Fatalf("moca-egress: %v", err)
	}
	if err := checkLocalAddrs(cfg.LocalAddrs); err != nil {
		log.Fatalf("moca-egress: %v", err)
	}
	proxy, err := egress.NewProxy(cfg)
	if err != nil {
		log.Fatalf("moca-egress: %v", err)
	}
	srv, err := control.NewServer(cc.Socket, cc.AllowedUIDs, proxy)
	if err != nil {
		proxy.Close()
		log.Fatalf("moca-egress: control socket %s: %v", cc.Socket, err)
	}
	// Flushes the audit queue. Called after proxy.Close() in every arm below, never before:
	// Unregister emits one aborted event per live connection as it tears down, and those are
	// only written if the sink outlives it.
	closeAudit := func() {
		if err := egress.CloseAudit(cfg.Audit); err != nil {
			log.Printf("moca-egress: audit sink: %v", err)
		}
	}

	if ctx.Err() != nil {
		// Stopped before we began serving: nothing is registered yet, so close and exit 0.
		srv.Close()
		proxy.Close()
		closeAudit()
		return
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve() }()
	if cp, ok := cfg.Credentials.(*egress.CPCredentials); ok {
		log.Printf("moca-egress: credentials: on (control plane %s)", cp.Host())
	} else {
		log.Printf("moca-egress: credentials: off")
	}
	if cfg.AllowAll {
		// Plainly, so an operator reading the journal cannot miss the mode (review #886): the
		// allowlist is off, and only the always-refused tier (cloud metadata, link-local)
		// remains.
		log.Printf("moca-egress: allow-all mode: every destination permitted (MOCA_EGRESS_ALLOW=*), control socket %s", cc.Socket)
	} else {
		log.Printf("moca-egress: serving %d allowlist entries, control socket %s", len(cfg.Allow), cc.Socket)
	}
	// The control socket is bound (NewServer listened on it above), so a worker ordered After=
	// this Type=notify unit can connect from here on. A failed notify is logged, not fatal:
	// systemd then fails the start on its own timeout, which names this unit.
	if err := sdNotify("READY=1"); err != nil {
		log.Printf("moca-egress: %v", err)
	}

	select {
	case <-ctx.Done():
		srv.Close()
		<-serveErr
		proxy.Close()
		closeAudit()
	case err := <-serveErr:
		if err != nil {
			log.Printf("moca-egress: control server: %v", err)
			proxy.Close()
			closeAudit()
			os.Exit(1)
		}
		proxy.Close()
		closeAudit()
	}
}
