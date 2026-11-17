//go:build unix

package conformance

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

// The environment variables of the contract.
const (
	EnvTenancy     = "MOCA_TENANCY"
	EnvAllow       = "MOCA_EGRESS_ALLOW"
	EnvPermit      = "MOCA_EGRESS_PERMIT_CIDRS"
	EnvResolver    = "MOCA_EGRESS_RESOLVER"
	EnvMaxConns    = "MOCA_EGRESS_MAX_CONNS_PER_VM"
	EnvMaxRequests = "MOCA_EGRESS_MAX_REQUESTS_PER_SESSION"
	EnvControlSock = "MOCA_EGRESS_CONTROL_SOCK"
	EnvControlUIDs = "MOCA_EGRESS_CONTROL_UIDS"
	// Whole seconds. Both bound an established connection, which until #585
	// had no time bound at all once its request headers were read.
	EnvIdleTimeout    = "MOCA_EGRESS_IDLE_TIMEOUT_S"
	EnvRespHeaderTime = "MOCA_EGRESS_RESPONSE_HEADER_TIMEOUT_S"
	// Credential injection (SBX0.2b). With the URL unset, setting any of the
	// others is a boot failure.
	EnvCredentialsURL       = "MOCA_EGRESS_CREDENTIALS_URL"
	EnvCredentialsTokenFile = "MOCA_EGRESS_CREDENTIALS_TOKEN_FILE"
	EnvCredentialsCA        = "MOCA_EGRESS_CREDENTIALS_CA"
	EnvCredentialsTimeout   = "MOCA_EGRESS_CREDENTIALS_TIMEOUT"
	EnvNoneTTL              = "MOCA_EGRESS_NONE_TTL_S"
	EnvCACertFile           = "MOCA_EGRESS_CA_CERT_FILE"
	EnvCAKeyFile            = "MOCA_EGRESS_CA_KEY_FILE"
	EnvUpstreamCA           = "MOCA_EGRESS_UPSTREAM_CA"
)

// Instance is one running implementation.
type Instance interface {
	// ControlSocket is the path of its control socket.
	ControlSocket() string
	// Audit delivers its audit events, one decoded JSON object per line, in
	// order. It is closed once the instance has stopped and every line has
	// been delivered. A line that is not a JSON object arrives as
	// {"_unparsed": line}, which no case accepts as an event.
	Audit() <-chan map[string]any
	// Stop stops the instance and releases everything it holds.
	Stop() error
}

// Target starts an implementation configured by env, which holds every
// variable the instance sees. Start returns once the control socket at
// env[MOCA_EGRESS_CONTROL_SOCK] accepts connections.
type Target interface {
	Start(ctx context.Context, env map[string]string) (Instance, error)
}

// Case is one named conformance case. Run returns nil on a pass and a
// descriptive error on a failure.
type Case struct {
	Name string
	Run  func(ctx context.Context, t Target) error
}

// Cases returns the transport-slice cases, in a fixed order.
func Cases() []Case {
	return []Case{
		{"identity_from_connection", identityFromConnection},
		{"forged_session_header_ignored", forgedSessionHeaderIgnored},
		{"off_allowlist_named_403", offAllowlistNamed403},
		{"private_address_403", privateAddress403},
		{"metadata_address_403_even_if_permitted", metadataAddress403EvenIfPermitted},
		{"dns_rebinding_resolved_once", dnsRebindingResolvedOnce},
		{"per_vm_conn_cap_429", perVMConnCap429},
		{"per_session_request_cap_429", perSessionRequestCap429},
		{"unregister_aborts_inflight", unregisterAbortsInflight},
		{"connect_tunnel_opaque", connectTunnelOpaque},
		{"plain_http_strips_proxy_and_moca_headers", plainHTTPStripsProxyAndMocaHeaders},
		{"audit_query_removed", auditQueryRemoved},
		{"grant_refused_under_single", grantRefusedUnderSingle},
		{"connect_tunnel_idle_deadline", connectTunnelIdleDeadline},
		{"forward_response_header_timeout", forwardResponseHeaderTimeout},
		{"credential_injected_placeholder_overwritten", credentialInjectedPlaceholderOverwritten},
		{"no_credential_tunnelled_opaque", noCredentialTunnelledOpaque},
		{"lookup_error_503_no_dial", lookupError503NoDial},
		{"upstream_unverified_502", upstreamUnverified502},
		{"inner_host_mismatch_421", innerHostMismatch421},
		{"plaintext_http_credential_403", plaintextHTTPCredential403},
		{"credential_keyed_by_session", credentialKeyedBySession},
		{"lookup_cached_single_flight", lookupCachedSingleFlight},
		{"credential_revoked_mid_connection_401", credentialRevokedMidConnection401},
		{"credential_selected_by_path_prefix", credentialSelectedByPathPrefix},
		{"path_traversal_refused_when_path_scoped", pathTraversalRefusedWhenPathScoped},
		{"credential_sets_every_header", credentialSetsEveryHeader},
		{"credential_port_scoped", credentialPortScoped},
		{"trace_refused_on_intercepted_conn", traceRefusedOnInterceptedConn},
	}
}

// DecodeAudit reads JSON lines from r until EOF and delivers each as a
// decoded object. Delivery is unbounded, so a slow reader never stalls the
// writer. The returned channel closes after the last line; done closes when
// reading has ended. An in-process Target can reuse it on a pipe.
func DecodeAudit(r io.Reader) (events <-chan map[string]any, done <-chan struct{}) {
	out := make(chan map[string]any)
	fin := make(chan struct{})
	var mu sync.Mutex
	var queue []map[string]any
	eof := false
	more := make(chan struct{}, 1)
	go func() {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			var m map[string]any
			if json.Unmarshal(sc.Bytes(), &m) != nil || m == nil {
				m = map[string]any{"_unparsed": sc.Text()}
			}
			mu.Lock()
			queue = append(queue, m)
			mu.Unlock()
			select {
			case more <- struct{}{}:
			default:
			}
		}
		_, _ = io.Copy(io.Discard, r)
		mu.Lock()
		eof = true
		mu.Unlock()
		select {
		case more <- struct{}{}:
		default:
		}
		close(fin)
	}()
	go func() {
		defer close(out)
		for {
			mu.Lock()
			q, end := queue, eof
			queue = nil
			mu.Unlock()
			for _, m := range q {
				out <- m
			}
			if len(q) == 0 {
				if end {
					return
				}
				<-more
			}
		}
	}()
	return out, fin
}

// Bounds of the cases' waits.
const (
	eventWait = 5 * time.Second
	ioWait    = 15 * time.Second
	quietWait = 300 * time.Millisecond
)

// harness is one case's world: a fake DNS server, a fake vmpool (a
// control.Client) and one running instance.
type harness struct {
	ctx    context.Context
	dir    string
	dns    *fakeDNS
	env    map[string]string
	inst   Instance
	client *control.Client
	seen   []map[string]any
	ups    []io.Closer
}

// newHarness creates the case's directory and fake DNS, and fills in the
// resolver and control-socket variables. The caller adds the rest of env
// and calls start.
func newHarness(ctx context.Context) (*harness, error) {
	// Short AND writable: darwin's sun_path is 104 bytes, and /tmp is not writable everywhere
	// (a sandbox, a hardened image), so this honours TMPDIR when a directory under it still has
	// room for the "/c.sock" below, and falls back when it does not. See internal/shortdir.
	dir, err := shortdir.Make("mconf", len("/vm-a.sock"))
	if err != nil {
		return nil, err
	}
	dns, err := startDNS()
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	h := &harness{ctx: ctx, dir: dir, dns: dns}
	sock := filepath.Join(dir, "c.sock")
	h.env = map[string]string{
		EnvResolver:    dns.addr(),
		EnvControlSock: sock,
		EnvControlUIDs: strconv.Itoa(os.Getuid()),
	}
	return h, nil
}

func (h *harness) start(t Target) error {
	inst, err := t.Start(h.ctx, h.env)
	if err != nil {
		return fmt.Errorf("start: %w", err)
	}
	h.inst = inst
	h.client = control.NewClient(inst.ControlSocket())
	return nil
}

// close stops everything; it reports a Stop failure, which a case adds to its
// result when nothing else failed.
func (h *harness) close() error {
	var err error
	if h.client != nil {
		_ = h.client.Close()
	}
	if h.inst != nil {
		err = h.inst.Stop()
		// Drain what is left so the instance's delivery goroutine can end.
		timer := time.NewTimer(eventWait)
	drain:
		for {
			select {
			case _, ok := <-h.inst.Audit():
				if !ok {
					break drain
				}
			case <-timer.C:
				break drain
			}
		}
		timer.Stop()
	}
	for _, u := range h.ups {
		_ = u.Close()
	}
	h.dns.close()
	_ = os.RemoveAll(h.dir)
	return err
}

// run builds a harness, lets setup fill in env and upstreams, starts the
// target and runs body. A failure to stop the instance fails the case too.
func run(ctx context.Context, t Target, setup func(h *harness) error, body func(h *harness) error) (err error) {
	h, err := newHarness(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := h.close(); cerr != nil && err == nil {
			err = fmt.Errorf("stop: %w", cerr)
		}
	}()
	if err := setup(h); err != nil {
		return fmt.Errorf("setup: %w", err)
	}
	if err := h.start(t); err != nil {
		return err
	}
	return body(h)
}

// vm is one fake guest VM: the path of its egress socket.
type vm struct{ id, sid, path string }

// newVMListener binds a fresh VM socket and returns it with its File. The
// socket path is not unlinked when the listener closes.
func (h *harness) newVMListener(id string) (*net.UnixListener, *os.File, string, error) {
	path := filepath.Join(h.dir, id+".sock")
	_ = os.Remove(path)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, nil, "", err
	}
	ln.SetUnlinkOnClose(false)
	f, err := ln.File()
	if err != nil {
		_ = ln.Close()
		return nil, nil, "", err
	}
	return ln, f, path, nil
}

// register binds a VM socket and hands it over, as vmpool does. The
// harness's own copies are closed afterwards, so the instance (and the
// client's dup) alone keep the socket alive.
func (h *harness) register(id, sid string) (vm, error) {
	ln, f, path, err := h.newVMListener(id)
	if err != nil {
		return vm{}, err
	}
	defer ln.Close()
	defer f.Close()
	if err := h.client.Register(h.ctx, id, sid, nil, f); err != nil {
		return vm{}, fmt.Errorf("register %s: %w", id, err)
	}
	return vm{id: id, sid: sid, path: path}, nil
}

// guest is one guest connection to its VM's egress socket.
type guest struct {
	c  net.Conn
	br *bufio.Reader
}

func (h *harness) dial(v vm) (*guest, error) {
	var d net.Dialer
	c, err := d.DialContext(h.ctx, "unix", v.path)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", v.id, err)
	}
	_ = c.SetDeadline(time.Now().Add(ioWait))
	return &guest{c: c, br: bufio.NewReader(c)}, nil
}

func (g *guest) close() { _ = g.c.Close() }

// response is a parsed response with its body read in full.
type response struct {
	status int
	header http.Header
	body   string
}

// do writes raw and reads one response to a request of method.
func (g *guest) do(method, raw string) (response, error) {
	if _, err := io.WriteString(g.c, raw); err != nil {
		return response{}, fmt.Errorf("write request: %w", err)
	}
	return g.read(method)
}

func (g *guest) read(method string) (response, error) {
	resp, err := http.ReadResponse(g.br, &http.Request{Method: method})
	if err != nil {
		return response{}, fmt.Errorf("read response: %w", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return response{}, fmt.Errorf("read body: %w", err)
	}
	return response{status: resp.StatusCode, header: resp.Header, body: string(b)}, nil
}

// get sends an absolute-form GET for url with the extra header lines.
func (g *guest) get(url string, extra ...string) (response, error) {
	host := strings.TrimPrefix(url, "http://")
	if i := strings.IndexByte(host, '/'); i >= 0 {
		host = host[:i]
	}
	var b strings.Builder
	fmt.Fprintf(&b, "GET %s HTTP/1.1\r\nHost: %s\r\n", url, host)
	for _, e := range extra {
		b.WriteString(e + "\r\n")
	}
	b.WriteString("\r\n")
	return g.do(http.MethodGet, b.String())
}

// connect sends CONNECT hostport and, on success, checks the exact
// established line. It returns the response for a refusal.
func (g *guest) connect(hostport string) (response, error) {
	raw := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", hostport, hostport)
	if _, err := io.WriteString(g.c, raw); err != nil {
		return response{}, fmt.Errorf("write CONNECT: %w", err)
	}
	return g.readConnectReply()
}

func (g *guest) readConnectReply() (response, error) {
	b, err := g.br.Peek(len(established))
	if err == nil && string(b) == established {
		_, _ = g.br.Discard(len(established))
		return response{status: 200}, nil
	}
	r, err := g.read(http.MethodConnect)
	if err != nil {
		return response{}, err
	}
	if r.status == 200 {
		return r, fmt.Errorf("CONNECT answered 200 without the exact %q", established)
	}
	return r, nil
}

const established = "HTTP/1.1 200 Connection Established\r\n\r\n"

// wantRefusal checks a named refusal: status, X-Moca-Egress-Error and the
// "<code>: <name>\n" body.
func wantRefusal(r response, status int, code, name string) error {
	if r.status != status {
		return fmt.Errorf("status %d, want %d %s (body %q)", r.status, status, code, r.body)
	}
	if got := r.header.Get("X-Moca-Egress-Error"); got != code {
		return fmt.Errorf("X-Moca-Egress-Error %q, want %q", got, code)
	}
	if ct := r.header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		return fmt.Errorf("Content-Type %q, want text/plain", ct)
	}
	// The first line is the contract; free text may follow it (moca-egress
	// says there what to do about a destination_denied, #779).
	if want := code + ": " + name + "\n"; !strings.HasPrefix(r.body, want) {
		return fmt.Errorf("body %q, want a first line %q", r.body, want)
	}
	return nil
}

// event matches an audit event field by field; numbers compare as numbers.
type event map[string]any

func (want event) match(m map[string]any) bool {
	for k, v := range want {
		got, ok := m[k]
		if !ok {
			return false
		}
		switch w := v.(type) {
		case int:
			if f, ok := got.(float64); !ok || f != float64(w) {
				return false
			}
		default:
			if got != v {
				return false
			}
		}
	}
	return true
}

// next receives one audit event within d.
func (h *harness) next(d time.Duration) (map[string]any, bool, error) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case m, ok := <-h.inst.Audit():
		if !ok {
			return nil, false, errors.New("audit stream closed")
		}
		if u, bad := m["_unparsed"]; bad {
			return nil, false, fmt.Errorf("audit line is not a JSON object: %v", u)
		}
		h.seen = append(h.seen, m)
		return m, true, nil
	case <-timer.C:
		return nil, false, nil
	case <-h.ctx.Done():
		return nil, false, h.ctx.Err()
	}
}

// wait returns the first event, seen or arriving within eventWait, that
// matches want. Every event must carry via="moca-egress".
func (h *harness) wait(want event) (map[string]any, error) {
	for _, m := range h.seen {
		if want.match(m) {
			return m, nil
		}
	}
	deadline := time.Now().Add(eventWait)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return nil, fmt.Errorf("no audit event matching %v within %v; saw %s", map[string]any(want), eventWait, h.seenText())
		}
		m, ok, err := h.next(left)
		if err != nil {
			return nil, fmt.Errorf("waiting for %v: %w; saw %s", map[string]any(want), err, h.seenText())
		}
		if ok {
			if m["via"] != "moca-egress" {
				return nil, fmt.Errorf("audit event with via %v, want moca-egress: %v", m["via"], m)
			}
			if want.match(m) {
				return m, nil
			}
		}
	}
}

// settle drains the events that arrive within quietWait.
func (h *harness) settle() error {
	for {
		_, ok, err := h.next(quietWait)
		if err != nil || !ok {
			return err
		}
	}
}

// count reports how many seen events match want.
func (h *harness) count(want event) int {
	n := 0
	for _, m := range h.seen {
		if want.match(m) {
			n++
		}
	}
	return n
}

func (h *harness) seenText() string {
	var b strings.Builder
	for _, m := range h.seen {
		j, _ := json.Marshal(redactEvent(m))
		b.Write(j)
		b.WriteByte('\n')
	}
	if b.Len() == 0 {
		return "(no events)"
	}
	return "\n" + b.String()
}

// redactEvent copies m with every value that could carry a secret replaced:
// those under a key such as authorization, cookie, x-api-key or value, and
// any string that looks like a Bearer or Basic credential. Failure messages
// of a public suite must not print a credential.
func redactEvent(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		switch lk := strings.ToLower(k); {
		case lk == "authorization" || lk == "cookie" || lk == "x-api-key" || lk == "value" || lk == "token":
			out[k] = "<redacted>"
		default:
			if s, ok := v.(string); ok && (strings.Contains(s, "Bearer ") || strings.Contains(s, "Basic ")) {
				out[k] = "<redacted>"
			} else {
				out[k] = v
			}
		}
	}
	return out
}

// ---- fake upstreams ----

// echoUpstream accepts TCP on 127.0.0.1, echoes each conn until EOF and then
// half-closes. It counts accepts.
type echoUpstream struct {
	ln      net.Listener
	mu      sync.Mutex
	accepts int
}

func (h *harness) echo() (*echoUpstream, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	e := &echoUpstream{ln: ln}
	h.ups = append(h.ups, ln)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			e.mu.Lock()
			e.accepts++
			e.mu.Unlock()
			go func() {
				defer c.Close()
				_, _ = io.Copy(c, c)
				if tc, ok := c.(*net.TCPConn); ok {
					_ = tc.CloseWrite()
				}
			}()
		}
	}()
	return e, nil
}

func (e *echoUpstream) port() int { return e.ln.Addr().(*net.TCPAddr).Port }

func (e *echoUpstream) acceptCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.accepts
}

// silentUpstream accepts TCP on 127.0.0.1, reads whatever arrives and never
// answers, holding every conn open until it is closed. It is the upstream a
// time bound is about: one that is reachable and responsive at the TCP layer
// and says nothing at the HTTP layer, so nothing short of a deadline ends the
// connection.
type silentUpstream struct {
	ln   net.Listener
	done chan struct{}
	once sync.Once
}

func (h *harness) silent() (*silentUpstream, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &silentUpstream{ln: ln, done: make(chan struct{})}
	h.ups = append(h.ups, s)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				// Drain so the kernel buffers never push back and make the
				// proxy's write, rather than its read, the thing that blocks.
				go func() { _, _ = io.Copy(io.Discard, c) }()
				<-s.done
			}()
		}
	}()
	return s, nil
}

func (s *silentUpstream) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

func (s *silentUpstream) Close() error {
	s.once.Do(func() { close(s.done) })
	return s.ln.Close()
}

// seenRequest is what the fake HTTP upstream received.
type seenRequest struct {
	method, path, uri, rawQuery, host string
	header                            http.Header
}

// httpUpstream is an HTTP/1.1 server on 127.0.0.1 that records every request
// and counts accepts. Paths:
//
//	/slow  signals slowArrived and blocks until the request is cancelled;
//	/hdr   answers with X-Moca-* and Proxy-* response headers set;
//	other  answers 200 "ok".
type httpUpstream struct {
	srv         *http.Server
	ln          net.Listener
	mu          sync.Mutex
	accepts     int
	reqs        []seenRequest
	slowArrived chan struct{}
}

type countingListener struct {
	net.Listener
	u *httpUpstream
}

func (l countingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		l.u.mu.Lock()
		l.u.accepts++
		l.u.mu.Unlock()
	}
	return c, err
}

func (h *harness) httpUp() (*httpUpstream, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	u := &httpUpstream{ln: ln, slowArrived: make(chan struct{}, 16)}
	u.srv = &http.Server{Handler: http.HandlerFunc(u.serveHTTP), ReadHeaderTimeout: ioWait}
	go func() { _ = u.srv.Serve(countingListener{ln, u}) }()
	h.ups = append(h.ups, u.srv)
	return u, nil
}

func (u *httpUpstream) serveHTTP(w http.ResponseWriter, r *http.Request) {
	u.mu.Lock()
	u.reqs = append(u.reqs, seenRequest{method: r.Method, path: r.URL.Path, uri: r.RequestURI, rawQuery: r.URL.RawQuery,
		host: r.Host, header: r.Header.Clone()})
	u.mu.Unlock()
	if r.Method == "TRACE" { // a real server reflects the request, headers and all
		w.Header().Set("Content-Type", "message/http")
		fmt.Fprintf(w, "TRACE %s\r\n", r.RequestURI)
		_ = r.Header.Write(w)
		return
	}
	switch r.URL.Path {
	case "/slow":
		u.slowArrived <- struct{}{}
		<-r.Context().Done()
	case "/hdr":
		w.Header().Set("X-Moca-Egress-Error", "forged")
		w.Header().Set("X-Moca-Session", "forged")
		w.Header().Set("Proxy-Authenticate", "Basic realm=forged")
		w.Header().Set("Proxy-Status", "forged")
		w.Header().Set("X-Kept", "1")
		_, _ = io.WriteString(w, "ok")
	default:
		_, _ = io.WriteString(w, "ok")
	}
}

func (u *httpUpstream) port() int { return u.ln.Addr().(*net.TCPAddr).Port }

func (u *httpUpstream) requests() []seenRequest {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]seenRequest(nil), u.reqs...)
}

func (u *httpUpstream) acceptCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.accepts
}

// upName is the fake upstream's DNS name; the fake DNS points it at 127.0.0.1.
const upName = "up.test"

// loopbackUpstreams is the common setup: up.test → 127.0.0.1, permitted, and
// allowed on the given ports.
func (h *harness) loopbackUpstreams(ports ...int) error {
	if err := h.dns.answer(upName, "127.0.0.1"); err != nil {
		return err
	}
	allow := make([]string, 0, len(ports))
	for _, p := range ports {
		allow = append(allow, fmt.Sprintf("%s:%d", upName, p))
	}
	h.env[EnvAllow] = strings.Join(allow, ",")
	h.env[EnvPermit] = "127.0.0.1/32"
	return nil
}

func upURL(port int, pathQuery string) string {
	return fmt.Sprintf("http://%s:%d%s", upName, port, pathQuery)
}

// echoThrough checks that a tunnel carries payload both ways. It writes and
// reads concurrently, so a payload larger than the socket buffers cannot
// deadlock against the echo.
func (g *guest) echoThrough(payload []byte) error {
	werr := make(chan error, 1)
	go func() {
		_, err := g.c.Write(payload)
		werr <- err
	}()
	got := make([]byte, len(payload))
	_, rerr := io.ReadFull(g.br, got)
	if err := <-werr; err != nil {
		return fmt.Errorf("tunnel write: %w", err)
	}
	if rerr != nil {
		return fmt.Errorf("tunnel read: %w", rerr)
	}
	if !bytes.Equal(got, payload) {
		return fmt.Errorf("tunnel echoed %d bytes that differ from the %d sent", len(got), len(payload))
	}
	return nil
}

// closedWithin reports whether the conn is closed by the far end within d,
// without any further bytes.
func (g *guest) closedWithin(d time.Duration) error {
	_ = g.c.SetReadDeadline(time.Now().Add(d))
	b := make([]byte, 64)
	n, err := g.br.Read(b)
	if n > 0 {
		return fmt.Errorf("got %q, want the conn closed", b[:n])
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return fmt.Errorf("conn still open after %v", d)
	}
	return nil
}
