// Command e12-guest-client is a build-time helper for deploy/microvm/e12-vsock-egress-probe.sh.
// It speaks the same framed protocol internal/vmpool/guestconn.go speaks at serve
// time, but from a throwaway process instead of the pool - E12's driver has no pool,
// the same reason deploy/microvm/build-snapshot.sh generates its own copy
// (guest_client.go, written at run time into a temp package) rather than importing
// this one. That script's copy and this one are intentionally the same shape; this
// one exists as a committed, directly buildable package because E12's driver is not
// build-snapshot.sh and reaching into its temp-package generator would recreate
// exactly the cross-script coupling deploy/microvm/e12-vsock-egress-probe.sh's own
// header comment says to avoid.
//
// Firecracker's and Cloud Hypervisor's Unix-socket vsock backends both proxy a host
// connection into the guest's listener on a fixed port via a one-line handshake: the
// host writes "CONNECT <port>\n" on the VMM-created Unix socket and, once the guest
// has accept()ed, the socket becomes a raw duplex stream to the guest side.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	ga "github.com/rossoctl/moca/remote-worker/internal/guestagent"
)

func main() {
	uds := flag.String("uds", "", "path to the VMM's vsock unix socket")
	port := flag.Uint("port", 1024, "guest vsock port the agent listens on")
	command := flag.String("command", "", "command to run in the guest; empty means probe-only")
	timeoutS := flag.Uint("timeout-s", 30, "guest-side command timeout")
	probeOnly := flag.Bool("probe-only", false, "just prove the guest is accepting; run nothing")
	dialTimeout := flag.Duration("dial-timeout", 10*time.Second, "how long to wait for the CONNECT handshake")
	flag.Parse()

	if *uds == "" {
		fmt.Fprintln(os.Stderr, "e12-guest-client: -uds is required")
		os.Exit(2)
	}

	conn, err := dialGuest(*uds, uint32(*port), *dialTimeout)
	if err != nil {
		fmt.Fprintf(os.Stderr, "e12-guest-client: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	if *probeOnly {
		return
	}

	req := ga.Request{Command: *command, TimeoutS: uint32(*timeoutS), CapBytes: ga.MaxFrame, HostUnixNanos: time.Now().UnixNano()}
	if err := ga.WriteJSON(conn, ga.KindRequest, req); err != nil {
		fmt.Fprintf(os.Stderr, "e12-guest-client: send request: %v\n", err)
		os.Exit(1)
	}
	if err := ga.WriteFrame(conn, ga.KindStdinEOF, nil); err != nil {
		fmt.Fprintf(os.Stderr, "e12-guest-client: send stdin-eof: %v\n", err)
		os.Exit(1)
	}

	for {
		kind, payload, err := ga.ReadFrame(conn)
		if err != nil {
			fmt.Fprintf(os.Stderr, "e12-guest-client: read: %v\n", err)
			os.Exit(1)
		}
		switch kind {
		case ga.KindStdout:
			os.Stdout.Write(payload)
		case ga.KindStderr:
			os.Stderr.Write(payload)
		case ga.KindEnd:
			var e ga.End
			if err := json.Unmarshal(payload, &e); err != nil {
				fmt.Fprintf(os.Stderr, "e12-guest-client: undecodable End: %v\n", err)
				os.Exit(1)
			}
			os.Exit(int(e.ExitCode))
		case ga.KindError:
			fmt.Fprintf(os.Stderr, "e12-guest-client: guest error: %s\n", payload)
			os.Exit(1)
		}
	}
}

// dialGuest performs the VMM's vsock Unix-socket CONNECT handshake and returns the
// resulting duplex connection. Copied unchanged from build-snapshot.sh's own
// guest_client.go, INCLUDING its readLine helper below - not simplified to a bulk
// conn.Read(buf), because a bulk read can consume bytes belonging to the guest
// agent's OWN first protocol frame if it answers fast enough to already be in
// flight right behind the ack. remote-worker/internal/vmpool/vsock.go's dialVsock
// hits this exact race and wraps its connection in a handshakeConn to replay any
// over-read bytes; build-snapshot.sh instead reads the ack strictly byte-by-byte so
// there is nothing to over-read in the first place. This file follows that second,
// simpler approach - never re-simplify readLine back into a bulk conn.Read, and
// never drop the read deadline around it (an ack that never arrives would
// otherwise hang this client forever despite -dial-timeout implying it can't).
func dialGuest(uds string, port uint32, timeout time.Duration) (net.Conn, error) {
	d := net.Dialer{Timeout: timeout}
	conn, err := d.Dial("unix", uds)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", uds, err)
	}
	if _, err := fmt.Fprintf(conn, "CONNECT %d\n", port); err != nil {
		conn.Close()
		return nil, fmt.Errorf("send CONNECT: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	line, err := readLine(conn)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("read CONNECT ack: %w", err)
	}
	if !strings.HasPrefix(line, "OK") {
		conn.Close()
		return nil, fmt.Errorf("CONNECT %d refused: %q", port, line)
	}
	_ = conn.SetReadDeadline(time.Time{})
	return conn, nil
}

// readLine reads byte-by-byte until '\n' - copied unchanged from
// build-snapshot.sh's own helper of the same name. Deliberately NOT a
// bufio.Reader or a bulk conn.Read: either can read past the '\n' into the
// guest agent's own first protocol frame, and this connection is handed
// straight to ga.ReadFrame afterward with no mechanism to replay over-read
// bytes (unlike remote-worker/internal/vmpool/vsock.go's handshakeConn, which
// exists specifically to solve that problem for a different caller). Slow by
// design, on a handshake line of a few bytes this cost is immaterial.
func readLine(conn net.Conn) (string, error) {
	buf := make([]byte, 0, 64)
	one := make([]byte, 1)
	for {
		if _, err := conn.Read(one); err != nil {
			return "", err
		}
		if one[0] == '\n' {
			return string(buf), nil
		}
		buf = append(buf, one[0])
	}
}
