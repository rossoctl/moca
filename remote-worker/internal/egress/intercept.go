package egress

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// expectContinueWait bounds how long a request that sent Expect: 100-continue
// waits for the upstream's verdict before its body is sent anyway (RFC 9110
// §10.1.1: a client does not wait forever for a server that never answers).
const expectContinueWait = time.Second

// maxInterim bounds the 1xx responses (other than 100) discarded per request.
const maxInterim = 10

var errExpectDenied = errors.New("egress: upstream answered an Expect: 100-continue with a final status")

// tlsInterceptor is the interceptor: it terminates the guest's TLS with a
// leaf from the host CA, injects the owner's credential, and re-encrypts to
// the real upstream.
type tlsInterceptor struct {
	ca    *LeafCA
	roots *x509.CertPool // nil: system roots
}

// newInterceptor returns the interceptor for hosts that have credentials.
// upstreamRoots verifies upstream servers; nil means the system roots.
func newInterceptor(ca *LeafCA, upstreamRoots *x509.CertPool) interceptor {
	return &tlsInterceptor{ca: ca, roots: upstreamRoots}
}

// brConn is a conn whose reads come from r (a bufio.Reader that already holds
// bytes the guest sent behind its CONNECT) while everything else is the conn's.
type brConn struct {
	net.Conn
	r io.Reader
}

func (c brConn) Read(p []byte) (int, error) { return c.r.Read(p) }

type upResult struct {
	resp *http.Response
	err  error
}

// icConn is the state of one intercepted connection.
type icConn struct {
	pc   *proxyConn
	t    target
	ic   *tlsInterceptor
	dial string

	k    *idleClock
	gtls *tls.Conn
	glr  *limitedReader
	gbr  *bufio.Reader
	utls *tls.Conn
	up   net.Conn
	ulr  *limitedReader
	ubr  *bufio.Reader
	ubw  *bufio.Writer
	rht  time.Duration

	// injected maps the PathPrefix of every element this connection has
	// injected to its Name (spec §5.2, Revocation).
	injected map[string]string
}

func (ic *tlsInterceptor) serve(pc *proxyConn, t target, addrs []netip.Addr, br *bufio.Reader, ev Event) {
	cfg := &pc.p.cfg
	up, err := pc.dial(addrs, t.port)
	if err != nil {
		ev.Status, ev.Decision = http.StatusBadGateway, DecisionUpstreamUnreachable
		pc.refuse(ev, t.display)
		return
	}
	ev.DialAddr = up.RemoteAddr().String()
	if !pc.setUpstream(up) {
		_ = up.Close()
		return
	}
	k := bothWays(pc.c, up, cfg.IdleTimeout)
	k.touch()

	// The upstream is verified before the guest is told anything: once a 200
	// is written no status can follow, and a leaf is never minted for an
	// upstream that did not verify.
	utls := tls.Client(idleConn{Conn: up, k: k}, &tls.Config{
		ServerName: t.host,
		NextProtos: []string{"http/1.1"},
		RootCAs:    ic.roots,
		MinVersion: tls.VersionTLS12,
	})
	hctx, cancel := context.WithTimeout(pc.ctx, cfg.DialTimeout)
	err = utls.HandshakeContext(hctx)
	cancel()
	if err != nil {
		ev.Status, ev.Decision = http.StatusBadGateway, DecisionUpstreamUnverified
		pc.refuse(ev, t.display)
		return
	}
	if _, err := io.WriteString(pc.c, connectEstablished); err != nil {
		return
	}

	c := &icConn{pc: pc, t: t, ic: ic, dial: ev.DialAddr, k: k, utls: utls, up: up, rht: cfg.ResponseHeaderTimeout,
		injected: map[string]string{}}
	c.ulr = &limitedReader{r: utls, n: maxHeaderBytes}
	c.ubr = bufio.NewReader(c.ulr)
	c.ubw = bufio.NewWriterSize(utls, 32<<10)

	c.gtls = tls.Server(idleConn{Conn: brConn{Conn: pc.c, r: br}, k: k}, &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
		GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
			if !c.sniMatches(h.ServerName) {
				pc.emit(Event{Host: t.host, Method: http.MethodConnect, Status: http.StatusMisdirectedRequest,
					DialAddr: c.dial, Decision: DecisionMisdirected}, true)
				return nil, errors.New("egress: SNI does not match the CONNECT host")
			}
			leaf, err := ic.ca.Leaf(t.host)
			if err != nil {
				// Handshake failure plus an audit event; never a panic.
				pc.emit(Event{Host: t.host, Method: http.MethodConnect, Status: http.StatusBadGateway,
					DialAddr: c.dial, Decision: DecisionLeafUnavailable}, true)
			}
			return leaf, err
		},
	})
	defer func() {
		// The slot first (#783): tls.Conn.Close writes close_notify before it closes pc.c, and a
		// guest may reconnect the moment it reads that orderly EOF, before boundConn.Close would
		// release it.
		pc.release()
		_ = c.gtls.Close()
		_ = utls.Close()
	}()
	if err := c.gtls.HandshakeContext(pc.ctx); err != nil {
		return
	}
	c.glr = &limitedReader{r: c.gtls, n: maxHeaderBytes}
	c.gbr = bufio.NewReader(c.glr)
	for c.next() {
	}
}

// sniMatches reports whether the guest's SNI names the CONNECT host. A guest
// that connects to an IP literal sends none.
func (c *icConn) sniMatches(sni string) bool {
	if sni == "" {
		_, err := netip.ParseAddr(c.t.host)
		return err == nil
	}
	h, err := NormalizeHost(sni)
	return err == nil && h == c.t.host
}

// refuse writes a named refusal over the guest TLS, emits its event and ends
// the conn. It reports false so callers can `return c.refuse(...)`. Like
// proxyConn.refuse, it writes nothing on a conn Unregister aborted (#825).
func (c *icConn) refuse(e Event, base Event) bool {
	if c.pc.wasAborted() {
		return false
	}
	base.Status, base.Decision = e.Status, e.Decision
	if e.Credential != "" {
		base.Credential = e.Credential
	}
	c.pc.emit(base, true)
	// The guest TLS writes through the idle clock's wrapper: stop the clock
	// first, or the write's own refresh replaces this drain deadline with the
	// idle one.
	c.k.stop()
	_ = c.gtls.SetWriteDeadline(time.Now().Add(drainTimeout))
	if _, err := c.gtls.Write(refusalBytes(e.Status, e.Decision, c.t.host)); err != nil {
		// The guest did not take the refusal within drainTimeout, so it will
		// not take a close_notify either: tls.Conn's close_notify write sets
		// its own five-second deadline, which would hold the conn that much
		// longer, once here and once more in serve's deferred Close. Closing
		// the socket under the TLS makes both fail at once.
		_ = c.pc.c.Close()
		return false
	}
	// Armed before CloseWrite, so the close_notify write is inside the same
	// bound as the drain: a guest that read the refusal and then stopped
	// reading cannot stretch it to tls.Conn's five seconds.
	t := time.AfterFunc(drainTimeout, func() { _ = c.pc.c.Close() })
	_ = c.gtls.CloseWrite()
	// Let a client that already sent its request see the refusal, not an RST.
	_, _ = io.Copy(io.Discard, io.LimitReader(c.gtls, drainLimit))
	t.Stop()
	return false
}

// hostMatches reports whether a Host header names the CONNECT target.
func (c *icConn) hostMatches(host string) bool {
	h, p := host, ""
	if sh, sp, err := net.SplitHostPort(host); err == nil {
		h, p = sh, sp
	}
	h = strings.TrimSuffix(strings.TrimPrefix(strings.TrimSuffix(h, "]"), "["), ".")
	nh, err := NormalizeHost(h)
	if err != nil || nh != c.t.host {
		return false
	}
	if p != "" {
		n := 0
		for _, ch := range p {
			if ch < '0' || ch > '9' || n > 65535 {
				return false
			}
			n = n*10 + int(ch-'0')
		}
		return n == int(c.t.port)
	}
	return true
}

// rawPathUnsafe reports whether the request-target, exactly as read, has a
// shape an upstream that normalises paths could route past a credential's
// prefix (spec §5.2, Path confusion).
func rawPathUnsafe(requestURI string) bool {
	raw := requestURI
	if i := strings.IndexByte(raw, '?'); i >= 0 {
		raw = raw[:i]
	}
	if strings.ContainsAny(raw, `\;%#`) || strings.Contains(raw, "//") {
		return true
	}
	for _, seg := range strings.Split(raw, "/") {
		if seg == "." || seg == ".." {
			return true
		}
	}
	return false
}

// next serves one request. It reports whether the conn may carry another.
func (c *icConn) next() bool {
	pc := c.pc
	c.glr.n = maxHeaderBytes
	req, err := http.ReadRequest(c.gbr)
	if err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) || pc.ctx.Err() != nil || isTimeout(err) {
			return false
		}
		return c.refuse(Event{Status: http.StatusBadRequest, Decision: DecisionBadRequest},
			Event{Host: c.t.host, DialAddr: c.dial})
	}
	c.glr.n = -1
	pc.setTarget(req.Method, c.t.host)
	base := Event{Host: c.t.host, DialAddr: c.dial, Method: req.Method, Path: RedactPath(req.URL)}
	bad := func(status int, decision string) bool {
		return c.refuse(Event{Status: status, Decision: decision}, base)
	}

	if !pc.p.countRequest(pc.caller.SessionID) {
		return bad(http.StatusTooManyRequests, DecisionRequestCap)
	}
	if req.ProtoMajor != 1 || req.ProtoMinor != 1 || !strings.HasPrefix(req.RequestURI, "/") {
		return bad(http.StatusBadRequest, DecisionBadRequest)
	}
	if !c.hostMatches(req.Host) {
		return bad(http.StatusMisdirectedRequest, DecisionMisdirected)
	}
	// TRACE and TRACK reflect the request, injected credential included, back
	// to the guest. Refused before revocation and selection, nothing upstream.
	if m := strings.ToUpper(req.Method); m == "TRACE" || m == "TRACK" {
		return bad(http.StatusMethodNotAllowed, DecisionBadRequest)
	}
	// Re-read the credential: a cache hit while the entry is fresh.
	all, err := pc.p.cfg.Credentials.Lookup(pc.ctx, pc.caller, c.t.host)
	if err != nil {
		return bad(http.StatusServiceUnavailable, DecisionCredentialUnavailable)
	}
	set := forPort(all, int(c.t.port))
	// Checked on the raw request-target, before any decoding.
	if pathScoped(set) && rawPathUnsafe(req.RequestURI) {
		return bad(http.StatusBadRequest, DecisionBadRequest)
	}
	path := req.URL.Path
	// Revocation runs before selection, so a deleted prefix can never fall
	// back to a shorter prefix's token on a conn that used it.
	for prefix, name := range c.injected {
		if !prefixMatches(prefix, path) {
			continue
		}
		held := false
		for _, e := range set {
			if e.PathPrefix == prefix && e.Name == name {
				held = true
				break
			}
		}
		if !held {
			return c.refuse(Event{Status: http.StatusUnauthorized, Decision: DecisionCredentialRevoked, Credential: name}, base)
		}
	}
	cred, matched := selectFor(set, path)
	if matched {
		c.injected[cred.PathPrefix] = cred.Name
	}

	scrubHeaders(req.Header)
	// An uncovered request gets ordinary scrubbing only (spec 5.2), so the
	// guest's own Authorization passes.
	if matched {
		// Matched: the guest's Authorization goes, then the element's headers are set; uncovered keeps it.
		req.Header.Del("Authorization")
		for _, h := range cred.Headers { // read-only: the slice is shared with the cache
			req.Header.Set(h.Name, h.Value)
		}
		base.Decision, base.Credential, base.Sub = DecisionCredentialInjected, cred.Name, cred.Subject
	} else {
		base.Decision = DecisionForward
	}
	return c.exchange(req, base)
}

// exchange sends req upstream and relays the response.
func (c *icConn) exchange(req *http.Request, ev Event) bool {
	pc := c.pc
	guestClose := req.Close
	// The upstream sees the checked target as Host, whatever the guest said.
	// The control plane's parseDestination refuses IPv6 literals in phase 1;
	// the bracketing is here so a later phase cannot send a bare "::1" Host.
	req.Host = c.t.host
	if c.t.port != 443 || strings.Contains(c.t.host, ":") {
		req.Host = net.JoinHostPort(c.t.host, strconv.Itoa(int(c.t.port)))
	}
	req.Close = false
	req.Trailer = nil
	if _, ok := req.Header["User-Agent"]; !ok {
		req.Header["User-Agent"] = []string{""} // suppress Go's default User-Agent
	}
	var bytesUp atomic.Int64
	hasBody := req.Body != nil && req.Body != http.NoBody
	var orig io.ReadCloser = req.Body
	expect := hasBody && strings.EqualFold(strings.TrimSpace(req.Header.Get("Expect")), "100-continue")
	var early *http.Response
	var ur upReader
	ur.c = c
	if hasBody {
		kb := keptBody{countingBody: countingBody{ReadCloser: orig, n: &bytesUp}, k: c.k}
		req.Body = kb
		if expect {
			req.Body = &expectGate{ReadCloser: kb, fn: func() error {
				if err := c.ubw.Flush(); err != nil {
					return err
				}
				select {
				case r := <-ur.ch:
					if r.err != nil {
						return r.err
					}
					if r.resp.StatusCode == http.StatusContinue {
						if _, err := io.WriteString(c.gtls, "HTTP/1.1 100 Continue\r\n\r\n"); err != nil {
							return err
						}
						ur.start(req)
						return nil
					}
					early = r.resp
					return errExpectDenied
				case <-time.After(expectContinueWait):
					return nil
				}
			}}
		}
	}

	ur.start(req)
	werr := req.Write(c.ubw)
	if werr == nil {
		werr = c.ubw.Flush()
	}
	var watchdog *time.Timer
	if c.rht > 0 {
		// Closing the conn is what unblocks the pending read for good: a read
		// deadline would be pushed out again by the next idle refresh.
		watchdog = time.AfterFunc(c.rht, func() { _ = c.up.Close() })
	}
	stop := func() {
		if watchdog != nil {
			watchdog.Stop()
		}
	}
	var resp *http.Response
	interim := 0
	if early != nil {
		resp = early
		stop()
	} else {
		for {
			r := <-ur.ch
			if r.err != nil {
				stop()
				ev.BytesUp = bytesUp.Load()
				// The request did carry the token: ev.Credential stays and the
				// Decision names the failure.
				return c.refuse(Event{Status: http.StatusBadGateway, Decision: DecisionUpstreamUnreachable}, ev)
			}
			if r.resp.StatusCode == http.StatusContinue {
				if _, err := io.WriteString(c.gtls, "HTTP/1.1 100 Continue\r\n\r\n"); err != nil {
					stop()
					return false
				}
				ur.start(req)
				continue
			}
			if sc := r.resp.StatusCode; sc >= 102 && sc < 200 && interim < maxInterim {
				// 103 Early Hints and the like: not relayed, the wait goes on.
				interim++
				ur.start(req)
				continue
			}
			if r.resp.StatusCode >= 100 && r.resp.StatusCode < 200 {
				// Upgrade was stripped: an upstream switching protocols (101)
				// unasked, or past the interim bound, is never relayed.
				stop()
				ev.BytesUp = bytesUp.Load()
				return c.refuse(Event{Status: http.StatusBadGateway, Decision: DecisionUpstreamUnreachable}, ev)
			}
			resp = r.resp
			stop()
			break
		}
	}
	c.ulr.n = -1
	defer resp.Body.Close()

	scrubHeaders(resp.Header)
	scrubTrailer(resp.Trailer)
	keep := werr == nil && !guestClose && !resp.Close && (resp.ContentLength >= 0 || chunked(resp.TransferEncoding))
	resp.Close = !keep
	var bytesDown atomic.Int64
	resp.Body = trailerScrubBody{countingBody{ReadCloser: resp.Body, n: &bytesDown}, resp}
	wErr := resp.Write(c.gtls)

	ev.Status = resp.StatusCode
	ev.BytesUp, ev.BytesDown = bytesUp.Load(), bytesDown.Load()
	pc.emit(ev, false)
	if wErr != nil || !keep {
		return false
	}
	// Any request body the upstream left unread would be parsed as the next
	// request: drain a bounded amount, else end the conn.
	if hasBody {
		if n, err := io.Copy(io.Discard, io.LimitReader(keptBody{
			countingBody: countingBody{ReadCloser: orig, n: new(atomic.Int64)}, k: c.k,
		}, drainLimit+1)); err != nil || n > drainLimit {
			return false
		}
	}
	return true
}

// upReader reads one upstream response at a time on its own goroutine, so a
// 100 Continue can be relayed while the request body is still being sent.
type upReader struct {
	c  *icConn
	ch chan upResult
}

func (u *upReader) start(req *http.Request) {
	ch := make(chan upResult, 1)
	u.ch = ch
	c := u.c
	c.ulr.n = maxHeaderBytes
	go func() {
		resp, err := http.ReadResponse(c.ubr, req)
		ch <- upResult{resp, err}
	}()
}

// expectGate holds the first read of a request body until fn says go. The
// request's headers are already buffered when that first read happens, so fn
// flushes them, then waits for the upstream's 100 Continue (relaying it to the
// guest) before the guest is asked for its body.
type expectGate struct {
	io.ReadCloser
	fn   func() error
	done bool
	err  error
}

func (g *expectGate) Read(p []byte) (int, error) {
	if !g.done {
		g.done = true
		g.err = g.fn()
	}
	if g.err != nil {
		return 0, g.err
	}
	return g.ReadCloser.Read(p)
}
