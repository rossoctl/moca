package egress

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"time"
)

const (
	// maxHeaderBytes bounds one request's line and headers; http.ReadRequest
	// itself has no limit.
	maxHeaderBytes = 1 << 20
	// headerTimeout bounds how long a request's headers, or an idle
	// keep-alive gap, may take. It frees a conn slot held by a silent guest.
	headerTimeout = 60 * time.Second
	// drainLimit and drainTimeout bound the read after a refusal, which lets
	// a client that already sent its request see the refusal, not an RST.
	drainLimit   = 64 << 10
	drainTimeout = time.Second
	// maxCapRefusalsPerVM bounds how many connection-cap refusals one VM may
	// have in flight, each holding a socket for up to two drainTimeouts. Past
	// it a refusal closes at once: the courtesy of a readable 429 is not worth
	// unbounded fds in a process shared by every VM. Not configurable; it is a
	// safety bound, not a policy.
	maxCapRefusalsPerVM = 8
	// capEventEvery bounds how often one VM's conn_cap events reach the audit
	// stream. Refusals inside an interval are counted onto the next event, so
	// a guest in a tight loop cannot flood out other VMs' events.
	capEventEvery = time.Second
)

// refusalHints is the text that follows a refusal's first line, for the codes
// whose fix is a person's, not a retry's (#779). The reader is as often an
// agent as a user, and with only "destination_denied: <host>" an agent went on
// probing or set out to build the package from source. Fixed text on purpose:
// the proxy does not know the deployment's user-facing URL (its credentials
// URL is the host's view of the control plane), and the allowlist itself is
// not echoed, since no API shows it to a sandbox's user either.

// allPrefixes permits every address CheckAddr would otherwise judge by the permit list: the
// allow-everything mode's stand-in for a configured list, so its always-refused tier still runs.
var allPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/0"),
	netip.MustParsePrefix("::/0"),
}

var refusalHints = map[string]string{
	DecisionDestinationDenied: "This host is not on this sandbox's egress allowlist, so the egress proxy refused it.\n" +
		"Retrying will not help: only the hosts the operator allowlisted are reachable.\n" +
		"To have it added, ask the operator of this Moca deployment. For a sandbox of the\n" +
		"sandbox service, `mocactl sbx egress` on your own machine lists the hosts it reached\n" +
		"and was refused.\n",
}

// refusalBytes renders a named refusal as a complete raw HTTP/1.1 response.
// The body's first line, "<code>: <host>", is the contract a client parses
// (with X-Moca-Egress-Error); a hint from refusalHints may follow it.
func refusalBytes(status int, code, host string) []byte {
	body := code + ": " + host + "\n" + refusalHints[code]
	return []byte(fmt.Sprintf("HTTP/1.1 %d %s\r\nContent-Type: text/plain\r\nX-Moca-Egress-Error: %s\r\n"+
		"Content-Length: %d\r\nConnection: close\r\n\r\n%s", status, http.StatusText(status), code, len(body), body))
}

// writeAndClose writes b, half-closes, drains briefly and closes c.
func writeAndClose(c net.Conn, b []byte) {
	_ = c.SetWriteDeadline(time.Now().Add(drainTimeout))
	_, _ = c.Write(b)
	if cw, ok := c.(closeWriter); ok {
		_ = cw.CloseWrite()
	}
	_ = c.SetReadDeadline(time.Now().Add(drainTimeout))
	_, _ = io.Copy(io.Discard, io.LimitReader(c, drainLimit))
	_ = c.Close()
}

// limitedReader caps bytes read through it until reset; it bounds headers
// while letting bodies through.
type limitedReader struct {
	r io.Reader
	n int64 // < 0 means unlimited
}

func (l *limitedReader) Read(b []byte) (int, error) {
	if l.n == 0 {
		return 0, errors.New("egress: request header too large")
	}
	if l.n > 0 && int64(len(b)) > l.n {
		b = b[:l.n]
	}
	n, err := l.r.Read(b)
	if l.n > 0 {
		l.n -= int64(n)
	}
	return n, err
}

// target is the destination of one request, before any check.
type target struct {
	connect bool
	host    string // normalised when ok
	port    uint16
	display string // the host as named in refusals and events
	bad     bool   // malformed or a rejected form
}

func parseTarget(r *http.Request) target {
	if r.Method == http.MethodConnect {
		t := target{connect: true, display: hostOnly(r.Host)}
		h, p, err := net.SplitHostPort(r.Host)
		if err != nil || r.URL.Path != "" || r.URL.Scheme != "" {
			t.bad = true
			return t
		}
		return t.resolve(h, p)
	}
	if !r.URL.IsAbs() || r.URL.Scheme != "http" || r.URL.Host == "" {
		return target{display: hostOnly(r.Host), bad: true}
	}
	t := target{display: hostOnly(r.URL.Hostname())}
	p := r.URL.Port()
	if p == "" {
		p = "80"
	}
	return t.resolve(r.URL.Hostname(), p)
}

func (t target) resolve(h, p string) target {
	n, err := strconv.ParseUint(p, 10, 16)
	hn, herr := NormalizeHost(h)
	if err != nil || n == 0 || herr != nil {
		t.bad = true
		return t
	}
	t.host, t.port, t.display = hn, uint16(n), hn
	return t
}

// hostOnly names the host of a rejected request for its refusal and event.
// It is guest-controlled, so anything that does not normalise is "-".
func hostOnly(hp string) string {
	if h, _, err := net.SplitHostPort(hp); err == nil {
		hp = h
	}
	if h, err := NormalizeHost(hp); err == nil && len(h) <= 253 {
		return h
	}
	return "-"
}

// serve reads requests from the guest until the conn ends.
func (pc *proxyConn) serve() {
	defer pc.finish()
	lr := &limitedReader{r: pc.c, n: maxHeaderBytes}
	br := bufio.NewReader(lr)
	for {
		lr.n = maxHeaderBytes
		_ = pc.c.SetReadDeadline(time.Now().Add(headerTimeout))
		r, err := http.ReadRequest(br)
		if err != nil {
			// A clean end between requests, an abort or an idle timeout is
			// not a request; anything else is a malformed one.
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) || pc.ctx.Err() != nil || isTimeout(err) {
				return
			}
			pc.refuse(Event{Status: 400, Decision: DecisionBadRequest}, "-")
			return
		}
		lr.n = -1
		_ = pc.c.SetReadDeadline(time.Time{})
		if !pc.handle(r, br) {
			return
		}
	}
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// refuse writes a named refusal, emits its one event and ends the conn. A conn
// Unregister aborted gets neither (#825): abort has written its one terminal
// event and closes the conn, and a refusal reached after it is the echo of
// abort's own cancel (an upstream request that failed because it was
// cancelled), which the guest must not read as the proxy's answer.
func (pc *proxyConn) refuse(e Event, host string) {
	if pc.wasAborted() {
		return
	}
	if e.Host == "" {
		e.Host = host
	}
	pc.emit(e, true)
	writeAndClose(pc.c, refusalBytes(e.Status, e.Decision, host))
}

// handle runs one request through the MI1 §8.5 order. It reports whether the
// conn may carry another request.
func (pc *proxyConn) handle(r *http.Request, br *bufio.Reader) bool {
	t := parseTarget(r)
	ev := Event{Host: t.display, Method: r.Method}
	if !t.connect && r.URL != nil {
		ev.Path = RedactPath(r.URL)
	}
	pc.setTarget(r.Method, t.display)
	refuse := func(status int, decision string) bool {
		ev.Status, ev.Decision = status, decision
		pc.refuse(ev, t.display)
		return false
	}
	if !pc.p.countRequest(pc.caller.SessionID) {
		return refuse(http.StatusTooManyRequests, DecisionRequestCap)
	}
	if t.bad || r.ProtoMajor != 1 || r.ProtoMinor != 1 {
		return refuse(http.StatusBadRequest, DecisionBadRequest)
	}
	if !pc.p.cfg.AllowAll && !Allowed(pc.p.cfg.Allow, t.host, t.port, t.connect) {
		return refuse(http.StatusForbidden, DecisionDestinationDenied)
	}
	addrs, decision := pc.resolveAndCheck(t.host)
	switch decision {
	case DecisionDestinationPrivate:
		return refuse(http.StatusForbidden, decision)
	case DecisionUpstreamUnreachable:
		return refuse(http.StatusBadGateway, decision)
	}
	set, err := pc.p.cfg.Credentials.Lookup(pc.ctx, pc.caller, t.host)
	if err != nil {
		// I5: an unknown credential state is never a tunnel.
		return refuse(http.StatusServiceUnavailable, DecisionCredentialUnavailable)
	}
	if len(forPort(set, int(t.port))) > 0 {
		if !t.connect {
			// Plain HTTP cannot carry a credential without exposing it.
			return refuse(http.StatusForbidden, DecisionPlaintextCredential)
		}
		pc.p.cfg.interceptor.serve(pc, t, addrs, br, ev)
		return false
	}
	up, err := pc.dial(addrs, t.port)
	if err != nil {
		return refuse(http.StatusBadGateway, DecisionUpstreamUnreachable)
	}
	ev.DialAddr = up.RemoteAddr().String()
	if !pc.setUpstream(up) {
		_ = up.Close()
		return false
	}
	if t.connect {
		pc.tunnel(up, br, ev)
		return false
	}
	return pc.forward(r, up, ev)
}

// resolveAndCheck resolves host exactly once (an IP literal skips DNS) and
// checks every answer. A single failing answer refuses the destination.
func (pc *proxyConn) resolveAndCheck(host string) ([]netip.Addr, string) {
	var addrs []netip.Addr
	if a, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{a}
	} else {
		ctx, cancel := context.WithTimeout(pc.ctx, pc.p.cfg.DialTimeout)
		addrs, err = pc.p.cfg.Resolver.LookupNetIP(ctx, "ip", host)
		cancel()
		if err != nil || len(addrs) == 0 {
			return nil, DecisionUpstreamUnreachable
		}
	}
	// Allow-everything mode (Config.AllowAll) keeps the always-refused tier -- link-local,
	// unspecified, multicast, broadcast and the cloud metadata endpoints: agent code runs on
	// untrusted content, so it must not fetch the host's instance credentials whatever the
	// operator permitted -- while permitting every other address, private and local included:
	// CheckAddr with an all-covering permit list and no local addresses.
	if pc.p.cfg.AllowAll {
		for _, a := range addrs {
			if err := CheckAddr(a, allPrefixes, nil); err != nil {
				return nil, DecisionDestinationPrivate
			}
		}
		return addrs, ""
	}
	var local []netip.Addr
	if f := pc.p.cfg.LocalAddrs; f != nil {
		l, err := f()
		if err != nil {
			// The host's own addresses are unknown: fail closed.
			return nil, DecisionDestinationPrivate
		}
		local = l
	}
	for _, a := range addrs {
		if err := CheckAddr(a, pc.p.cfg.PermitCIDRs, local); err != nil {
			return nil, DecisionDestinationPrivate
		}
	}
	return addrs, ""
}

// dial connects to the checked addresses in order.
func (pc *proxyConn) dial(addrs []netip.Addr, port uint16) (net.Conn, error) {
	d := net.Dialer{Timeout: pc.p.cfg.DialTimeout}
	var errs []error
	for _, a := range addrs {
		// Dial the address exactly as CheckAddr judged it: unmapped, no zone.
		c, err := d.DialContext(pc.ctx, "tcp", netip.AddrPortFrom(a.Unmap().WithZone(""), port).String())
		if err == nil {
			return c, nil
		}
		errs = append(errs, err)
	}
	return nil, errors.Join(errs...)
}
