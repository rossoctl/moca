//go:build unix

package egress

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
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

// recSink records events and their JSON form; safe for concurrent use.
type recSink struct {
	mu  sync.Mutex
	evs []Event
	js  bytes.Buffer
}

func (s *recSink) Emit(e Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.evs = append(s.evs, e)
	b, _ := json.Marshal(e)
	s.js.Write(b)
	s.js.WriteByte('\n')
}

func (s *recSink) events() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Event(nil), s.evs...)
}

func (s *recSink) jsonText() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.js.String()
}

// waitEvent polls until an event with the decision appears.
func (s *recSink) waitEvent(t *testing.T, decision string) Event {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range s.events() {
			if e.Decision == decision {
				return e
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no %q event; have %+v", decision, s.events())
	return Event{}
}

// mapResolver answers from a table; fn, when set, overrides it per call.
type mapResolver struct {
	mu    sync.Mutex
	m     map[string][]netip.Addr
	fn    map[string]func(call int) []netip.Addr
	calls map[string]int
}

func newResolver() *mapResolver {
	return &mapResolver{m: map[string][]netip.Addr{}, fn: map[string]func(int) []netip.Addr{}, calls: map[string]int{}}
}

func (r *mapResolver) set(host string, addrs ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var as []netip.Addr
	for _, a := range addrs {
		as = append(as, netip.MustParseAddr(a))
	}
	r.m[host] = as
}

func (r *mapResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls[host]++
	if f := r.fn[host]; f != nil {
		return f(r.calls[host]), nil
	}
	if as, ok := r.m[host]; ok {
		return as, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

func (r *mapResolver) count(host string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls[host]
}

// tcpUpstream is a raw TCP listener on 127.0.0.1 counting accepts.
type tcpUpstream struct {
	ln      net.Listener
	accepts atomic.Int64
	port    int
}

func newTCPUpstream(t *testing.T, handle func(net.Conn)) *tcpUpstream {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	u := &tcpUpstream{ln: ln, port: ln.Addr().(*net.TCPAddr).Port}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			u.accepts.Add(1)
			go handle(c)
		}
	}()
	return u
}

func echo(c net.Conn) { defer c.Close(); io.Copy(c, c) }

// httpUpstream is an httptest server on 127.0.0.1 recording requests.
type httpUpstream struct {
	srv     *httptest.Server
	port    int
	accepts atomic.Int64
	mu      sync.Mutex
	reqs    []*http.Request
}

func newHTTPUpstream(t *testing.T) *httpUpstream {
	t.Helper()
	u := &httpUpstream{}
	u.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.reqs = append(u.reqs, r)
		u.mu.Unlock()
		w.Header().Set("X-Moca-Egress-Error", "spoofed")
		fmt.Fprintf(w, "hello %s", r.URL.RawQuery)
	}))
	u.srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			u.accepts.Add(1)
		}
	}
	u.srv.Start()
	t.Cleanup(u.srv.Close)
	u.port = u.srv.Listener.Addr().(*net.TCPAddr).Port
	return u
}

func (u *httpUpstream) last(t *testing.T) *http.Request {
	t.Helper()
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.reqs) == 0 {
		t.Fatal("upstream saw no request")
	}
	return u.reqs[len(u.reqs)-1]
}

type fakePolicy struct {
	res   []Credential
	err   error
	calls atomic.Int32
}

func (f *fakePolicy) Lookup(context.Context, Caller, string) ([]Credential, error) {
	f.calls.Add(1)
	return f.res, f.err
}

type fakeInterceptor struct{ calls atomic.Int32 }

func (f *fakeInterceptor) serve(pc *proxyConn, _ target, _ []netip.Addr, _ *bufio.Reader, _ Event) {
	f.calls.Add(1)
	pc.c.Close()
}

type harness struct {
	t    *testing.T
	p    *Proxy
	sink *recSink
	res  *mapResolver
	dir  string
}

func allow(t *testing.T, s string) []AllowEntry {
	t.Helper()
	a, err := ParseAllow(s)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func newHarness(t *testing.T, allowList string, mod func(*Config)) *harness {
	t.Helper()
	dir := shortdir.New(t, "eg", len("/vm-quiet.sock"))
	h := &harness{t: t, sink: &recSink{}, res: newResolver(), dir: dir}
	cfg := Config{
		Allow:                 allow(t, allowList),
		PermitCIDRs:           []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")},
		MaxConnsPerVM:         8,
		MaxRequestsPerSession: 1000,
		Resolver:              h.res,
		Credentials:           NoCredentials{},
		Audit:                 h.sink,
		DialTimeout:           2 * time.Second,
	}
	if mod != nil {
		mod(&cfg)
	}
	p, err := NewProxy(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	h.p = p
	return h
}

// register binds a fresh unix listener for vmID/sid and returns its path.
func (h *harness) register(vmID, sid string) string {
	h.t.Helper()
	path := filepath.Join(h.dir, vmID+".sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		h.t.Fatal(err)
	}
	if err := h.p.Register(vmID, sid, nil, ln); err != nil {
		ln.Close()
		h.t.Fatal(err)
	}
	return path
}

func dial(t *testing.T, path string) *net.UnixConn {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(5 * time.Second))
	return c.(*net.UnixConn)
}

const established = "HTTP/1.1 200 Connection Established\r\n\r\n"

// connect sends CONNECT target and asserts the exact 200 line.
func connect(t *testing.T, c net.Conn, target string) {
	t.Helper()
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	buf := make([]byte, len(established))
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != established {
		t.Fatalf("CONNECT reply %q, %v", buf, err)
	}
}

// roundTrip writes raw and reads one response.
func roundTrip(t *testing.T, c net.Conn, raw string) (*http.Response, string) {
	t.Helper()
	if _, err := io.WriteString(c, raw); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(b)
}

func assertRefusal(t *testing.T, resp *http.Response, body string, status int, code, host string) {
	t.Helper()
	if resp.StatusCode != status {
		t.Fatalf("status %d, want %d (body %q)", resp.StatusCode, status, body)
	}
	if got := resp.Header.Get("X-Moca-Egress-Error"); got != code {
		t.Fatalf("X-Moca-Egress-Error %q, want %q", got, code)
	}
	// The first line is the contract ("<code>: <host>", conformance doc.go);
	// a hint may follow it (refusalHints).
	if want := code + ": " + host + "\n"; !strings.HasPrefix(body, want) {
		t.Fatalf("body %q, want a first line %q", body, want)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/plain" {
		t.Fatalf("content-type %q", ct)
	}
}

func TestConnectTunnelsToAnAllowlistedHost(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))
	c.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("echo %q, %v", buf, err)
	}
	c.Close()
	e := h.sink.waitEvent(t, DecisionTunnel)
	if e.SID != "run-a" || e.VMID != "vm-1" || e.DialAddr != fmt.Sprintf("127.0.0.1:%d", up.port) ||
		e.Status != 200 || e.BytesUp != 4 || e.BytesDown != 4 || e.Host != "up.test" || e.Method != "CONNECT" {
		t.Fatalf("event %+v", e)
	}
	if n := len(h.sink.events()); n != 1 {
		t.Fatalf("%d events, want 1: %+v", n, h.sink.events())
	}
}

func TestIdentityComesFromTheAcceptingSocket(t *testing.T) {
	up := newHTTPUpstream(t)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	h.register("vm-1", "run-a")
	c := dial(t, h.register("vm-2", "run-b"))
	resp, body := roundTrip(t, c, fmt.Sprintf("GET http://up.test:%d/x HTTP/1.1\r\nHost: up.test:%d\r\n"+
		"X-Moca-Session: run-a\r\nx-moca-vm: vm-1\r\nProxy-Authorization: Basic Zm9vOmJhcg==\r\n"+
		"Proxy-Connection: keep-alive\r\nProxy-Tenant: other\r\nproxy-remote-user: root\r\n\r\n", up.port, up.port))
	if resp.StatusCode != 200 || body != "hello " {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Moca-Egress-Error") != "" {
		t.Fatal("upstream X-Moca-* header leaked to the guest")
	}
	r := up.last(t)
	for k := range r.Header {
		if lk := strings.ToLower(k); strings.HasPrefix(lk, "x-moca-") || strings.HasPrefix(lk, "proxy-") {
			t.Fatalf("upstream saw %s", k)
		}
	}
	e := h.sink.waitEvent(t, DecisionForward)
	if e.SID != "run-b" || e.VMID != "vm-2" {
		t.Fatalf("identity from headers: %+v", e)
	}
}

// Allow-everything mode: a host that is off the allowlist and resolves to a
// private address still tunnels -- the allowlist is off and CheckAddr runs with an
// all-covering permit list, so only its always-refused tier remains.
func TestAllowAllTunnelsOffAllowlistAndPrivate(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, "up.test:443", func(c *Config) {
		c.AllowAll = true
		c.PermitCIDRs = nil // 127.0.0.1 would need a permit without AllowAll
	})
	h.res.set("evil.test", "127.0.0.1", "10.0.0.5")
	c := dial(t, h.register("vm-1", "run-a"))
	connect(t, c, fmt.Sprintf("evil.test:%d", up.port))
	c.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("echo %q, %v", buf, err)
	}
	c.Close()
	e := h.sink.waitEvent(t, DecisionTunnel)
	if e.Host != "evil.test" || e.Status != 200 {
		t.Fatalf("event %+v", e)
	}
}

// Allow-everything mode keeps the always-refused tier: the cloud metadata endpoints (AWS
// IMDSv4/v6, and the IPv6 form an allowlist could not name anyway) and link-local are refused
// exactly as with a configured list -- agent code runs on untrusted content, so it must not
// fetch the host's instance credentials whatever the operator permitted (review #886).
func TestAllowAllStillRefusesCloudMetadata(t *testing.T) {
	h := newHarness(t, "up.test:443", func(c *Config) {
		c.AllowAll = true
		c.PermitCIDRs = nil
	})
	path := h.register("vm-1", "run-a")
	// An IPv6 literal in a CONNECT authority is bracketed, as a client sends it; the refusal
	// names the address itself, unbracketed.
	for _, addr := range []string{"169.254.169.254", "[fd00:ec2::254]", "[fe80::1]"} {
		name := strings.Trim(addr, "[]")
		resp, body := roundTrip(t, dial(t, path), fmt.Sprintf("CONNECT %s:80 HTTP/1.1\r\n\r\n", addr))
		assertRefusal(t, resp, body, 403, DecisionDestinationPrivate, name)
	}
}

// NewProxy accepts an empty Allow only with AllowAll: the allow-everything mode's Config is
// built without a list (ConfigFromEnv sets none), while an ordinary Config with no list is the
// misconfiguration it always was (review #886).
func TestNewProxyEmptyAllowOnlyWithAllowAll(t *testing.T) {
	res := newResolver()
	// Every field but the allowlist, in both shapes: NewProxy's other validations must not
	// shadow the one under test.
	base := Config{Resolver: res, Credentials: NoCredentials{}, Audit: &recSink{}, DialTimeout: time.Second,
		MaxConnsPerVM: 8, MaxRequestsPerSession: 100}
	if _, err := NewProxy(Config{AllowAll: true, Resolver: res, Credentials: NoCredentials{}, Audit: &recSink{},
		DialTimeout: time.Second, MaxConnsPerVM: 8, MaxRequestsPerSession: 100}); err != nil {
		t.Fatalf("allow-all with no allowlist: %v", err)
	}
	if _, err := NewProxy(base); err == nil || err.Error() != "egress: empty allowlist" {
		t.Fatalf("empty allowlist without allow-all: %v", err)
	}
}

func TestOffAllowlistIsANamed403(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("evil.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	resp, body := roundTrip(t, c, fmt.Sprintf("CONNECT evil.test:%d HTTP/1.1\r\nHost: evil.test\r\n\r\n", up.port))
	assertRefusal(t, resp, body, 403, DecisionDestinationDenied, "evil.test")
	if up.accepts.Load() != 0 || h.res.count("evil.test") != 0 {
		t.Fatal("refused destination was resolved or dialed")
	}
	if e := h.sink.waitEvent(t, DecisionDestinationDenied); e.Status != 403 || e.Host != "evil.test" {
		t.Fatalf("event %+v", e)
	}
}

// TestOffAllowlistRefusalSaysWhatToDo is #779: the 403's body named only the
// code and the host, so an agent that met it went on probing, or set out to
// build a package from source, instead of reporting that the host is not
// allowlisted. The body now says so, that a retry will not help, and whom to
// ask, while its first line and the header stay what a client parses.
func TestOffAllowlistRefusalSaysWhatToDo(t *testing.T) {
	h := newHarness(t, "up.test:443", nil)
	c := dial(t, h.register("vm-1", "run-a"))
	resp, body := roundTrip(t, c, "GET http://evil.test/simple/ HTTP/1.1\r\nHost: evil.test\r\n\r\n")
	assertRefusal(t, resp, body, 403, DecisionDestinationDenied, "evil.test")
	for _, want := range []string{
		"not on this sandbox's egress allowlist",
		"Retrying will not help",
		"ask the operator",
		"mocactl sbx egress",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("body lacks %q:\n%s", want, body)
		}
	}
	// Nothing of the allowlist itself reaches the guest: the hint is fixed text.
	if strings.Contains(body, "up.test") {
		t.Errorf("body names an allowlisted host:\n%s", body)
	}
	if n, err := strconv.Atoi(resp.Header.Get("Content-Length")); err != nil || n != len(body) {
		t.Errorf("Content-Length %q for a %d-byte body", resp.Header.Get("Content-Length"), len(body))
	}
}

// Other refusals keep their one-line body: the hint is for the one an
// operator can fix by allowlisting the host.
func TestOtherRefusalsKeepOneLine(t *testing.T) {
	b := string(refusalBytes(502, DecisionUpstreamUnreachable, "up.test"))
	if _, body, _ := strings.Cut(b, "\r\n\r\n"); body != DecisionUpstreamUnreachable+": up.test\n" {
		t.Fatalf("body %q", body)
	}
}

func TestPrivateAnswerIsRefused(t *testing.T) {
	h := newHarness(t, "priv.test:443,169.254.169.254:80", nil)
	h.res.set("priv.test", "127.0.0.1", "10.0.0.5")
	path := h.register("vm-1", "run-a")
	resp, body := roundTrip(t, dial(t, path), "CONNECT priv.test:443 HTTP/1.1\r\nHost: priv.test\r\n\r\n")
	assertRefusal(t, resp, body, 403, DecisionDestinationPrivate, "priv.test")
	resp, body = roundTrip(t, dial(t, path), "CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n")
	assertRefusal(t, resp, body, 403, DecisionDestinationPrivate, "169.254.169.254")
	resp, body = roundTrip(t, dial(t, path), "GET http://169.254.169.254/latest/meta-data HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n")
	assertRefusal(t, resp, body, 403, DecisionDestinationPrivate, "169.254.169.254")
	if h.res.count("169.254.169.254") != 0 {
		t.Fatal("IP literal went to DNS")
	}
}

func TestResolvesOnceAndDialsTheCheckedAddress(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.fn["up.test"] = func(call int) []netip.Addr {
		if call == 1 {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}
		}
		return []netip.Addr{netip.MustParseAddr("10.0.0.9")}
	}
	c := dial(t, h.register("vm-1", "run-a"))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))
	c.Write([]byte("x"))
	b := make([]byte, 1)
	if _, err := io.ReadFull(c, b); err != nil || b[0] != 'x' {
		t.Fatalf("%q %v", b, err)
	}
	if n := h.res.count("up.test"); n != 1 {
		t.Fatalf("resolver called %d times", n)
	}
}

func TestPerVMConnCap(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), func(c *Config) { c.MaxConnsPerVM = 2 })
	h.res.set("up.test", "127.0.0.1")
	path := h.register("vm-1", "run-a")
	for i := 0; i < 2; i++ {
		connect(t, dial(t, path), fmt.Sprintf("up.test:%d", up.port))
	}
	// The third guest pipelines its CONNECT before reading: it must see the
	// named 429, not a reset from closing with unread input.
	c3 := dial(t, path)
	fmt.Fprintf(c3, "CONNECT up.test:%d HTTP/1.1\r\nHost: up.test\r\n\r\n%s", up.port, strings.Repeat("x", 8192))
	resp, err := http.ReadResponse(bufio.NewReader(c3), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	assertRefusal(t, resp, string(body), 429, DecisionConnCap, "vm-1")
	h.sink.waitEvent(t, DecisionConnCap)
}

// fakeClock is a clock the test advances by hand. It is read from the proxy's
// accept goroutine and written from the test, so both go through the mutex.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{t: time.Now()} }

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// capRefusalsInFlight reads vm's in-flight refusal count under the proxy lock.
func (h *harness) capRefusalsInFlight(vmID string) int {
	h.p.mu.Lock()
	defer h.p.mu.Unlock()
	b := h.p.vms[vmID]
	if b == nil {
		return 0
	}
	return b.capRefusals
}

// capCharged counts refusals charged to vm so far: every charge either becomes
// an event, or is suppressed and reported on a later event's Coalesced, or is
// still pending in the binding.
func (h *harness) capCharged(vmID string) int {
	n := 0
	for _, e := range capEvents(h.sink.events()) {
		if e.VMID == vmID {
			n += 1 + int(e.Coalesced)
		}
	}
	h.p.mu.Lock()
	defer h.p.mu.Unlock()
	if b := h.p.vms[vmID]; b != nil {
		n += int(b.capSuppressed)
	}
	return n
}

// waitCapCharged waits until want refusals have been charged to vm. The accept
// loop charges asynchronously, so totals are only stable once it has caught up.
func (h *harness) waitCapCharged(t *testing.T, vmID string, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if h.capCharged(vmID) >= want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("%d of %d refusals charged to %s", h.capCharged(vmID), want, vmID)
}

// TestCapRefusalsAreBoundedPerVM is #586's first defect: every refusal used to
// spawn a goroutine holding a socket for ~2s, so a guest in a tight loop could
// multiply fds in a process shared by every VM. Refusals in flight must stay
// under the bound no matter how many are offered.
func TestCapRefusalsAreBoundedPerVM(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), func(c *Config) { c.MaxConnsPerVM = 1 })
	h.res.set("up.test", "127.0.0.1")
	path := h.register("vm-1", "run-a")
	connect(t, dial(t, path), fmt.Sprintf("up.test:%d", up.port)) // fills the cap

	// Each of these is refused. None reads its 429, so a draining refusal stays
	// in flight for drainTimeout -- which is what makes the bound observable.
	const offered = maxCapRefusalsPerVM * 6
	peak := 0
	sample := func(at string) {
		n := h.capRefusalsInFlight("vm-1")
		if n > peak {
			peak = n
		}
		if n > maxCapRefusalsPerVM {
			t.Fatalf("%s: %d in flight, over the bound of %d: a guest can grow host fds without limit",
				at, n, maxCapRefusalsPerVM)
		}
	}
	for i := 0; i < offered; i++ {
		c := dial(t, path)
		fmt.Fprintf(c, "CONNECT up.test:%d HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port)
		sample(fmt.Sprintf("refusal %d", i))
	}
	// The offer loop never blocks -- the kernel completes the dials into the
	// listener backlog and the requests fit the socket buffers -- so on a
	// loaded runner it can finish before the accept goroutine has charged a
	// single refusal. The backlog still holds the offers, and a charged
	// refusal stays in flight for ~2*drainTimeout, so wait until every offer
	// has been charged: the bound must hold as they land, too, not only at
	// the first one the poll happens to see.
	if peak == 0 {
		deadline := time.Now().Add(3 * time.Second)
		for h.capCharged("vm-1") < offered && time.Now().Before(deadline) {
			sample("catch-up")
			time.Sleep(2 * time.Millisecond)
		}
		sample("catch-up")
	}
	if peak == 0 {
		t.Fatal("no refusal was ever in flight: the test did not exercise the refusal path")
	}
	t.Logf("offered %d refusals, peak in flight %d, bound %d", offered, peak, maxCapRefusalsPerVM)
}

// TestCapRefusalPastTheBoundClosesWithoutDraining pins the trade: below the
// bound a guest reads its 429 (TestPerVMConnCap), past it the fd is shed.
func TestCapRefusalPastTheBoundClosesWithoutDraining(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), func(c *Config) { c.MaxConnsPerVM = 1 })
	h.res.set("up.test", "127.0.0.1")
	path := h.register("vm-1", "run-a")
	connect(t, dial(t, path), fmt.Sprintf("up.test:%d", up.port))

	// Hold the bound full with refusals that never read their response.
	held := make([]net.Conn, 0, maxCapRefusalsPerVM)
	for i := 0; i < maxCapRefusalsPerVM; i++ {
		c := dial(t, path)
		fmt.Fprintf(c, "CONNECT up.test:%d HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port)
		held = append(held, c)
	}
	deadline := time.Now().Add(2 * time.Second)
	for h.capRefusalsInFlight("vm-1") < maxCapRefusalsPerVM && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	if n := h.capRefusalsInFlight("vm-1"); n != maxCapRefusalsPerVM {
		t.Fatalf("%d refusals in flight, want the bound %d held", n, maxCapRefusalsPerVM)
	}

	// One more: it is closed at once, so the read ends rather than returning a
	// 429 or hanging for drainTimeout. How it ends is the kernel's choice, not
	// this code's: the request sits unread in the receive buffer, so Linux
	// answers the close with an RST (ECONNRESET) where macOS gives EOF. Either
	// is a shed fd; what must hold is that no refusal was written and the read
	// did not block for drainTimeout.
	over := dial(t, path)
	fmt.Fprintf(over, "CONNECT up.test:%d HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port)
	over.SetReadDeadline(time.Now().Add(2 * time.Second))
	start := time.Now()
	b, err := io.ReadAll(over)
	if err != nil && isTimeout(err) {
		t.Fatalf("past the bound the read blocked for %v: the conn was drained, not shed", time.Since(start))
	}
	if len(b) != 0 {
		t.Fatalf("past the bound the guest got %q, want nothing written: the fd should be shed, not drained", b)
	}
	for _, c := range held {
		c.Close()
	}
}

// TestCapEventsAreCoalescedPerVM is the other half of defect 1: one conn_cap
// line per refusal floods journald, whose rate limit then drops other VMs'
// events. Repeats inside an interval must be counted onto one event.
func TestCapEventsAreCoalescedPerVM(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), func(c *Config) { c.MaxConnsPerVM = 1 })
	h.res.set("up.test", "127.0.0.1")

	// A clock the test owns, so coalescing is driven without sleeping. It is
	// read from the accept goroutine, hence the lock inside fakeClock.
	clk := newFakeClock()
	h.p.now = clk.now

	path := h.register("vm-1", "run-a")
	connect(t, dial(t, path), fmt.Sprintf("up.test:%d", up.port))

	refuse := func(n int) {
		for i := 0; i < n; i++ {
			c := dial(t, path)
			fmt.Fprintf(c, "CONNECT up.test:%d HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port)
			c.Close()
		}
	}
	const burst = 12
	refuse(burst)
	h.waitCapCharged(t, "vm-1", burst)
	if n := countDecision(h.sink.events(), DecisionConnCap); n != 1 {
		t.Fatalf("%d conn_cap events for %d refusals in one interval, want 1: a tight loop still floods the audit stream", n, burst)
	}

	// A new interval reports again, and carries what the first interval
	// suppressed, so the count is not lost.
	clk.advance(capEventEvery + time.Millisecond)
	refuse(1)
	deadline := time.Now().Add(3 * time.Second)
	for countDecision(h.sink.events(), DecisionConnCap) < 2 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	evs := capEvents(h.sink.events())
	if len(evs) != 2 {
		t.Fatalf("%d conn_cap events after a new interval, want 2", len(evs))
	}
	if evs[1].Coalesced == 0 {
		t.Fatal("the second event reports no suppressed refusals: the burst vanished from the audit trail")
	}
	// Every refusal is accounted for: two events plus what they coalesced.
	if total := 2 + int(evs[0].Coalesced) + int(evs[1].Coalesced); total != burst+1 {
		t.Fatalf("events account for %d refusals, want %d", total, burst+1)
	}
}

// TestOneVMsRefusalFloodDoesNotSuppressAnotherVMsEvents is the cross-tenant
// property that motivates #586: coalescing is per VM, so a noisy guest cannot
// silence a quiet one.
func TestOneVMsRefusalFloodDoesNotSuppressAnotherVMsEvents(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), func(c *Config) { c.MaxConnsPerVM = 1 })
	h.res.set("up.test", "127.0.0.1")
	clk := newFakeClock()
	h.p.now = clk.now

	noisy := h.register("vm-noisy", "run-a")
	quiet := h.register("vm-quiet", "run-b")
	hp := fmt.Sprintf("up.test:%d", up.port)
	connect(t, dial(t, noisy), hp)
	connect(t, dial(t, quiet), hp)

	for i := 0; i < 20; i++ {
		c := dial(t, noisy)
		fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: up.test\r\n\r\n", hp)
		c.Close()
	}
	// The quiet VM's single refusal, in the same interval, must still be
	// recorded: its first refusal is its own interval's first.
	c := dial(t, quiet)
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: up.test\r\n\r\n", hp)
	defer c.Close()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var quietSeen bool
		for _, e := range capEvents(h.sink.events()) {
			if e.VMID == "vm-quiet" {
				quietSeen = true
			}
		}
		if quietSeen {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("vm-quiet's refusal was never recorded while vm-noisy flooded; events: %+v", capEvents(h.sink.events()))
}

func countDecision(evs []Event, decision string) int {
	var n int
	for _, e := range evs {
		if e.Decision == decision {
			n++
		}
	}
	return n
}

func capEvents(evs []Event) []Event {
	var out []Event
	for _, e := range evs {
		if e.Decision == DecisionConnCap {
			out = append(out, e)
		}
	}
	return out
}

func TestPerSessionRequestCap(t *testing.T) {
	up := newHTTPUpstream(t)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), func(c *Config) { c.MaxRequestsPerSession = 3 })
	h.res.set("up.test", "127.0.0.1")
	paths := []string{h.register("vm-1", "run-a"), h.register("vm-2", "run-a")}
	req := fmt.Sprintf("GET http://up.test:%d/ HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port)
	for i := 0; i < 3; i++ {
		resp, body := roundTrip(t, dial(t, paths[i%2]), req)
		if resp.StatusCode != 200 {
			t.Fatalf("request %d: %d %q", i, resp.StatusCode, body)
		}
	}
	resp, body := roundTrip(t, dial(t, paths[1]), req)
	assertRefusal(t, resp, body, 429, DecisionRequestCap, "up.test")
}

func TestUnregisterAbortsInFlightTunnels(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	path := h.register("vm-1", "run-a")
	c := dial(t, path)
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))
	if err := h.p.Unregister("vm-1"); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("client not closed: %v", err)
	}
	h.sink.waitEvent(t, DecisionAborted)
	time.Sleep(50 * time.Millisecond)
	for _, e := range h.sink.events() {
		if e.Decision == DecisionTunnel {
			t.Fatalf("aborted tunnel also logged as tunnel: %+v", h.sink.events())
		}
	}
	if n := len(h.sink.events()); n != 1 {
		t.Fatalf("%d events: %+v", n, h.sink.events())
	}
	if c2, err := net.Dial("unix", path); err == nil {
		c2.Close()
		t.Fatal("socket still accepts after Unregister")
	}
	if err := h.p.Unregister("vm-unknown"); err != nil {
		t.Fatal(err)
	}
}

func TestPlainHTTPForwardsWithoutCredentialsAndRedactsQuery(t *testing.T) {
	up := newHTTPUpstream(t)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	req := fmt.Sprintf("GET http://up.test:%d/p?token=s3cret HTTP/1.1\r\nHost: up.test:%d\r\n\r\n", up.port, up.port)
	// Two requests on one keep-alive conn; each is checked and audited.
	br := bufio.NewReader(c)
	for i := 0; i < 2; i++ {
		io.WriteString(c, req)
		resp, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || string(b) != "hello token=s3cret" {
			t.Fatalf("%d %q", resp.StatusCode, b)
		}
	}
	r := up.last(t)
	if r.URL.RawQuery != "token=s3cret" || r.Header.Get("Authorization") != "" {
		t.Fatalf("upstream got %q auth=%q", r.URL.RawQuery, r.Header.Get("Authorization"))
	}
	if r.Host != fmt.Sprintf("up.test:%d", up.port) {
		t.Fatalf("upstream Host %q", r.Host)
	}
	e := h.sink.waitEvent(t, DecisionForward)
	if e.Path != "/p" || e.Status != 200 || e.DialAddr != "127.0.0.1:"+strconv.Itoa(up.port) || e.BytesDown == 0 {
		t.Fatalf("event %+v", e)
	}
	if n := h.res.count("up.test"); n != 2 {
		t.Fatalf("each request must re-resolve; resolver called %d times", n)
	}
	if strings.Contains(h.sink.jsonText(), "s3cret") {
		t.Fatal("audit leaked the query string")
	}
}

func credHarness(t *testing.T, allowList string, fp *fakePolicy, fi *fakeInterceptor) *harness {
	t.Helper()
	h := newHarness(t, allowList, func(c *Config) {
		c.Credentials = fp
		c.interceptor = fi
	})
	h.res.set("up.test", "127.0.0.1")
	return h
}

func TestLookupErrorRefuses503NoDial(t *testing.T) {
	tcp := newTCPUpstream(t, echo)
	fp := &fakePolicy{err: errors.New("unknown")}
	h := credHarness(t, fmt.Sprintf("up.test:%d", tcp.port), fp, &fakeInterceptor{})
	resp, body := roundTrip(t, dial(t, h.register("vm-1", "run-a")), fmt.Sprintf("CONNECT up.test:%d HTTP/1.1\r\n\r\n", tcp.port))
	assertRefusal(t, resp, body, 503, DecisionCredentialUnavailable, "up.test")
	h.sink.waitEvent(t, DecisionCredentialUnavailable)
	if tcp.accepts.Load() != 0 {
		t.Fatal("dialed after a lookup error")
	}
}

func TestLookupNoneTunnelsAsBefore(t *testing.T) {
	up := newTCPUpstream(t, echo)
	fi := &fakeInterceptor{}
	h := credHarness(t, fmt.Sprintf("up.test:%d", up.port), &fakePolicy{}, fi)
	c := dial(t, h.register("vm-1", "run-a"))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))
	c.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("echo %q, %v", buf, err)
	}
	c.Close()
	h.sink.waitEvent(t, DecisionTunnel)
	if fi.calls.Load() != 0 {
		t.Fatal("interceptor called")
	}
}

func TestLookupOtherPortTunnels(t *testing.T) {
	up := newTCPUpstream(t, echo)
	fi := &fakeInterceptor{}
	fp := &fakePolicy{res: []Credential{{Name: "x", PathPrefix: "/", Port: up.port + 1}}}
	h := credHarness(t, fmt.Sprintf("up.test:%d", up.port), fp, fi)
	c := dial(t, h.register("vm-1", "run-a"))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))
	c.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("echo %q, %v", buf, err)
	}
	c.Close()
	h.sink.waitEvent(t, DecisionTunnel)
	if fi.calls.Load() != 0 {
		t.Fatal("interceptor called for another port")
	}
}

func TestLookupFoundPlainHTTP403(t *testing.T) {
	up := newHTTPUpstream(t)
	fi := &fakeInterceptor{}
	fp := &fakePolicy{res: []Credential{{Name: "x", PathPrefix: "/", Port: up.port}}}
	h := credHarness(t, fmt.Sprintf("up.test:%d", up.port), fp, fi)
	resp, body := roundTrip(t, dial(t, h.register("vm-1", "run-a")), fmt.Sprintf("GET http://up.test:%d/ HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port))
	assertRefusal(t, resp, body, 403, DecisionPlaintextCredential, "up.test")
	h.sink.waitEvent(t, DecisionPlaintextCredential)
	if up.accepts.Load() != 0 || fi.calls.Load() != 0 {
		t.Fatal("plain HTTP with a credential reached upstream or the interceptor")
	}
}

func TestLookupFoundHandsToInterceptor(t *testing.T) {
	tcp := newTCPUpstream(t, echo)
	fi := &fakeInterceptor{}
	fp := &fakePolicy{res: []Credential{{Name: "x", PathPrefix: "/", Port: tcp.port}}}
	h := credHarness(t, fmt.Sprintf("up.test:%d", tcp.port), fp, fi)
	c := dial(t, h.register("vm-1", "run-a"))
	io.WriteString(c, fmt.Sprintf("CONNECT up.test:%d HTTP/1.1\r\n\r\n", tcp.port))
	io.Copy(io.Discard, c) // the fake closes the conn
	if n := fi.calls.Load(); n != 1 {
		t.Fatalf("interceptor called %d times", n)
	}
	if tcp.accepts.Load() != 0 {
		t.Fatal("dialed before the interceptor")
	}
}

func TestSelectFor(t *testing.T) {
	mk := func(ps ...string) []Credential {
		var s []Credential
		for _, p := range ps {
			s = append(s, Credential{Name: p, PathPrefix: p})
		}
		return s
	}
	all := mk("/", "/a", "/a/b")
	for path, want := range map[string]string{"/a/b/c": "/a/b", "/a/bc": "/a", "/x": "/", "/a": "/a"} {
		if c, ok := selectFor(all, path); !ok || c.PathPrefix != want {
			t.Errorf("%s -> %q, %v; want %q", path, c.PathPrefix, ok, want)
		}
	}
	only := mk("/a")
	if _, ok := selectFor(only, "/b"); ok {
		t.Error("/b matched /a")
	}
	if c, ok := selectFor(only, "/a"); !ok || c.PathPrefix != "/a" {
		t.Error("/a did not match /a")
	}
	if pathScoped(mk("/")) || !pathScoped(all) {
		t.Error("pathScoped wrong")
	}
	if got := forPort([]Credential{{Port: 1}, {Port: 2}}, 2); len(got) != 1 || got[0].Port != 2 {
		t.Errorf("forPort %+v", got)
	}
}

func TestLookupAfterAllowlist(t *testing.T) {
	fp := &fakePolicy{}
	h := credHarness(t, "other.test", fp, &fakeInterceptor{})
	resp, body := roundTrip(t, dial(t, h.register("vm-1", "run-a")), "CONNECT up.test:443 HTTP/1.1\r\n\r\n")
	assertRefusal(t, resp, body, 403, DecisionDestinationDenied, "up.test")
	if fp.calls.Load() != 0 {
		t.Fatal("Lookup called for an off-allowlist host")
	}
}

func TestNewProxyRefusesPolicyWithoutInterceptor(t *testing.T) {
	_, err := NewProxy(Config{
		Allow: allow(t, "up.test"), MaxConnsPerVM: 1, MaxRequestsPerSession: 1,
		Resolver: newResolver(), Credentials: &fakePolicy{}, Audit: &recSink{},
	})
	if err == nil || !strings.Contains(err.Error(), "needs an interceptor") {
		t.Fatalf("err = %v", err)
	}
}

func TestTunnelPropagatesHalfClose(t *testing.T) {
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		b, _ := io.ReadAll(c) // only returns on EOF
		if string(b) == "req" {
			c.Write([]byte("resp"))
		}
	})
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	// "req" rides in the same write as CONNECT: bytes buffered behind the
	// request line must reach the upstream first.
	fmt.Fprintf(c, "CONNECT up.test:%d HTTP/1.1\r\n\r\nreq", up.port)
	c.CloseWrite()
	b, err := io.ReadAll(c)
	if err != nil || string(b) != established+"resp" {
		t.Fatalf("got %q, %v", b, err)
	}
	if e := h.sink.waitEvent(t, DecisionTunnel); e.BytesUp != 3 || e.BytesDown != 4 {
		t.Fatalf("event %+v", e)
	}
}

// #585: an established connection used to have no time bound at all. The read
// deadline guarding the request headers is cleared once they are read
// (handler.go), and before this change nothing replaced it on either path, so
// a guest could pin every one of its connection slots -- and an upstream
// socket each, in a process shared by every VM -- for the VM's lifetime.
//
// idleHarness is a harness whose bounds are short enough to wait on. Both
// knobs are set: a test that bounds one must not pass because the other fired.
//
// Callers use 400ms rather than the tightest bound that works. These tests run
// under -race on shared CI runners, where a scheduling hiccup between a write
// and the deadline it was meant to refresh is the difference between pass and
// fail; the tests that *survive* a bound write at half the interval, so the
// margin is what absorbs that. The cost is a few seconds of wall clock, which
// is cheaper than a flake.
func idleHarness(t *testing.T, allowList string, idle, respHeader time.Duration) *harness {
	t.Helper()
	return newHarness(t, allowList, func(c *Config) {
		c.IdleTimeout = idle
		c.ResponseHeaderTimeout = respHeader
	})
}

// connsInFlight counts vm's live connection slots under the proxy lock. The
// cap is applied to this map, so it is what "the slot came back" means.
func (h *harness) connsInFlight(vmID string) int {
	h.p.mu.Lock()
	defer h.p.mu.Unlock()
	b := h.p.vms[vmID]
	if b == nil {
		return 0
	}
	return len(b.conns)
}

func (h *harness) waitConnsInFlight(t *testing.T, vmID string, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if h.connsInFlight(vmID) == want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("%s has %d conns in flight, want %d", vmID, h.connsInFlight(vmID), want)
}

// TestIdleTunnelIsClosedAndItsSlotFreed is the defect itself: a tunnel where
// neither side says anything must not be held forever, and the slot it held
// must return to the per-VM cap.
func TestIdleTunnelIsClosedAndItsSlotFreed(t *testing.T) {
	// The upstream accepts and then says nothing, which is the whole point:
	// without a deadline both copy goroutines block in Read indefinitely.
	up := newTCPUpstream(t, func(c net.Conn) { defer c.Close(); io.ReadAll(c) })
	h := idleHarness(t, fmt.Sprintf("up.test:%d", up.port), 400*time.Millisecond, 2*time.Second)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))

	// The tunnel event is emitted when the splice returns, so its arrival is
	// the proof the copy loops unblocked rather than the guest giving up.
	h.sink.waitEvent(t, DecisionTunnel)
	h.waitConnsInFlight(t, "vm-1", 0)
	if n, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatalf("guest conn still readable after the idle bound: %d bytes", n)
	}
}

// TestActiveTunnelSurvivesManyIdlePeriods is the regression the per-read reset
// exists to prevent. An absolute deadline, or one armed once before the copy
// loop, would kill a slow but healthy transfer -- a large repo being cloned.
// Only a deadline refreshed on every read lets this pass.
func TestActiveTunnelSurvivesManyIdlePeriods(t *testing.T) {
	up := newTCPUpstream(t, echo)
	const idle = 400 * time.Millisecond
	h := idleHarness(t, fmt.Sprintf("up.test:%d", up.port), idle, 2*time.Second)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	c.SetDeadline(time.Now().Add(10 * time.Second))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))

	// Six exchanges at half the bound: over 3x the idle timeout in total, with
	// no gap long enough to expire it.
	buf := make([]byte, 4)
	for i := 0; i < 6; i++ {
		time.Sleep(idle / 2)
		if _, err := c.Write([]byte("ping")); err != nil {
			t.Fatalf("write %d after %v: %v", i, time.Duration(i)*idle/2, err)
		}
		if _, err := io.ReadFull(c, buf); err != nil {
			t.Fatalf("read %d after %v: %v", i, time.Duration(i)*idle/2, err)
		}
	}
	if h.connsInFlight("vm-1") != 1 {
		t.Fatalf("active tunnel lost its slot: %d conns in flight", h.connsInFlight("vm-1"))
	}
}

// TestOneWayTunnelDownloadSurvivesASilentGuest is the case a per-leg bound got
// wrong. TestActiveTunnelSurvivesManyIdlePeriods echoes, so every read on both
// legs is refreshed by the guest's own pings and it passes either way. Here the
// traffic is one-way, which is what a `git clone` actually looks like: the
// guest says nothing at all for as long as the pack takes to stream down, so
// the guest→up leg's read has to be kept alive by the *other* leg's bytes or it
// expires on a perfectly healthy transfer and closeBoth tears it down.
func TestOneWayTunnelDownloadSurvivesASilentGuest(t *testing.T) {
	const idle = 400 * time.Millisecond
	const chunks = 8
	// A byte every half-interval, 4x the bound in total, and never a word from
	// the guest.
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		for i := 0; i < chunks; i++ {
			time.Sleep(idle / 2)
			if _, err := io.WriteString(c, "x"); err != nil {
				return
			}
		}
	})
	h := idleHarness(t, fmt.Sprintf("up.test:%d", up.port), idle, 5*time.Second)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	c.SetDeadline(time.Now().Add(10 * time.Second))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))

	if _, err := io.ReadFull(c, make([]byte, chunks)); err != nil {
		t.Fatalf("one-way download of %d bytes over %v failed: %v", chunks, chunks*idle/2, err)
	}
	if n := h.connsInFlight("vm-1"); n != 1 {
		t.Fatalf("streaming tunnel lost its slot: %d conns in flight, want 1", n)
	}
}

// TestOneWayTunnelUploadSurvivesASilentUpstream is the mirror -- a `git push`,
// where the upstream says nothing until the whole pack is in. The up→client
// leg's read is the one that would expire.
func TestOneWayTunnelUploadSurvivesASilentUpstream(t *testing.T) {
	const idle = 400 * time.Millisecond
	const chunks = 8
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		if _, err := io.ReadFull(c, make([]byte, chunks)); err != nil {
			return
		}
		io.WriteString(c, "ok") // only now, once the upload is complete
	})
	h := idleHarness(t, fmt.Sprintf("up.test:%d", up.port), idle, 5*time.Second)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	c.SetDeadline(time.Now().Add(10 * time.Second))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))

	for i := 0; i < chunks; i++ {
		time.Sleep(idle / 2)
		if _, err := c.Write([]byte("x")); err != nil {
			t.Fatalf("upload chunk %d after %v: %v", i, time.Duration(i)*idle/2, err)
		}
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ok" {
		t.Fatalf("one-way upload over %v got %q, %v; want the upstream's reply", chunks*idle/2, buf, err)
	}
}

// TestForwardSlowUploadSurvivesASilentUpstream is the forward path's version: a
// POST whose body trickles in over several times the bound, with an upstream
// that says nothing until the body is complete. End to end, the only activity
// anywhere is on the guest side.
//
// Honest note on its strength: this passes even with the upstream conn dropped
// from the request-body clock, because net/http swallows the readLoop's Peek
// error while a request is in flight, so the expiry it would cause never
// reaches the caller. The test pins the behaviour a guest sees; the reason the
// upstream deadline is in that clock anyway is in forward.go's comment, and it
// rests on the IdleTimeout invariant rather than on this assertion.
func TestForwardSlowUploadSurvivesASilentUpstream(t *testing.T) {
	const idle = 400 * time.Millisecond
	const chunks = 8
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		r, err := http.ReadRequest(bufio.NewReader(c))
		if err != nil {
			return
		}
		n, _ := io.Copy(io.Discard, r.Body) // says nothing until the body is in
		fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s", n, strings.Repeat("y", int(n)))
	})
	h := idleHarness(t, fmt.Sprintf("up.test:%d", up.port), idle, 5*time.Second)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := fmt.Fprintf(c, "POST http://up.test:%d/x HTTP/1.1\r\nHost: up.test\r\nContent-Length: %d\r\n\r\n", up.port, chunks); err != nil {
		t.Fatal(err)
	}
	// A byte every half-interval, 4x the bound in total.
	for i := 0; i < chunks; i++ {
		time.Sleep(idle / 2)
		if _, err := c.Write([]byte("x")); err != nil {
			t.Fatalf("upload chunk %d after %v: %v", i, time.Duration(i)*idle/2, err)
		}
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatalf("slow upload over %v got no response: %v", chunks*idle/2, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("slow upload got %d, want 200: the bound fired while bytes were moving", resp.StatusCode)
	}
	if e := h.sink.waitEvent(t, DecisionForward); e.BytesUp != chunks {
		t.Fatalf("event %+v, want all %d uploaded bytes", e, chunks)
	}
}

// TestHalfClosedIdleTunnelExpires covers the case the issue calls out: after a
// half-close exactly one leg is still running, so bounding only the guest's
// reads would leave a client that sent CloseWrite and then waits on a silent
// upstream holding its slot indefinitely.
func TestHalfClosedIdleTunnelExpires(t *testing.T) {
	// Reads to EOF, then holds the conn open saying nothing.
	done := make(chan struct{})
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		io.ReadAll(c)
		<-done
	})
	t.Cleanup(func() { close(done) })
	h := idleHarness(t, fmt.Sprintf("up.test:%d", up.port), 400*time.Millisecond, 2*time.Second)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))
	if err := c.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	h.sink.waitEvent(t, DecisionTunnel)
	h.waitConnsInFlight(t, "vm-1", 0)
}

// TestForwardResponseHeaderTimeout: an upstream that accepts the connection
// and never answers used to hang RoundTrip forever. It must become the 502 the
// unreachable-upstream arm already emits.
func TestForwardResponseHeaderTimeout(t *testing.T) {
	hold := make(chan struct{})
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		http.ReadRequest(bufio.NewReader(c))
		<-hold // read the request, answer nothing
	})
	t.Cleanup(func() { close(hold) })
	h := idleHarness(t, fmt.Sprintf("up.test:%d", up.port), 5*time.Second, 400*time.Millisecond)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	resp, body := roundTrip(t, c, fmt.Sprintf("GET http://up.test:%d/x HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port))
	assertRefusal(t, resp, body, 502, DecisionUpstreamUnreachable, "up.test")
	h.waitConnsInFlight(t, "vm-1", 0)
}

// TestForwardStalledResponseBodyExpires is the gap ResponseHeaderTimeout does
// not cover: headers arrive promptly and then the body stops. The bound has to
// be on the upstream conn itself, which is why the Transport is handed a
// wrapped conn rather than the raw one.
func TestForwardStalledResponseBodyExpires(t *testing.T) {
	hold := make(chan struct{})
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		http.ReadRequest(bufio.NewReader(c))
		// Promises 64 bytes, sends 4, then stalls.
		io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\nabcd")
		<-hold
	})
	t.Cleanup(func() { close(hold) })
	h := idleHarness(t, fmt.Sprintf("up.test:%d", up.port), 400*time.Millisecond, 5*time.Second)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	if _, err := fmt.Fprintf(c, "GET http://up.test:%d/x HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port); err != nil {
		t.Fatal(err)
	}
	// The forward event is emitted once resp.Write returns, which only happens
	// when the stalled body read fails. Without the bound it never returns.
	if e := h.sink.waitEvent(t, DecisionForward); e.BytesDown != 4 {
		t.Fatalf("event %+v, want the 4 bytes that did arrive", e)
	}
	h.waitConnsInFlight(t, "vm-1", 0)
}

// TestForwardSlowGuestReaderExpires bounds the other half of a stall: a guest
// that asks for a large response and then stops reading holds its slot just as
// effectively as one that stops sending, so the response write is bounded too.
func TestForwardSlowGuestReaderExpires(t *testing.T) {
	// Big enough that the write cannot complete into socket buffers alone.
	const size = 8 << 20
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		http.ReadRequest(bufio.NewReader(c))
		fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", size)
		io.Copy(c, io.LimitReader(zeros{}, size))
	})
	h := idleHarness(t, fmt.Sprintf("up.test:%d", up.port), 400*time.Millisecond, 5*time.Second)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := fmt.Fprintf(c, "GET http://up.test:%d/big HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port); err != nil {
		t.Fatal(err)
	}
	// Never read the body: the response write stalls once the buffers fill.
	h.sink.waitEvent(t, DecisionForward)
	h.waitConnsInFlight(t, "vm-1", 0)
}

// TestForwardStalledGuestBodyExpiresWhileUpstreamTalks is why the guest conn's
// bound lives on keptBody and not on the countingBody it embeds: that struct is
// shared with the response body, whose reads come off the *upstream* conn. Put
// the deadline there and an upstream that keeps talking would refresh the
// deadline guarding the guest's conn, so a guest that promised a body and never
// sent it would hold its slot for as long as the upstream cared to trickle.
//
// A serialized request/response cannot see this -- the two bodies never
// overlap. A duplex exchange can, so this is the only test that pins the
// placement.
func TestForwardStalledGuestBodyExpiresWhileUpstreamTalks(t *testing.T) {
	const idle = 400 * time.Millisecond
	const chunks = 8
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		http.ReadRequest(bufio.NewReader(c))
		fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", chunks)
		// A byte every half-interval: never idle from the upstream's side, and
		// 4x the bound in total, so a deadline wrongly refreshed by these reads
		// would carry the whole exchange through.
		for i := 0; i < chunks; i++ {
			time.Sleep(idle / 2)
			if _, err := io.WriteString(c, "x"); err != nil {
				return
			}
		}
	})
	h := idleHarness(t, fmt.Sprintf("up.test:%d", up.port), idle, 5*time.Second)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	c.SetDeadline(time.Now().Add(10 * time.Second))
	// Promises a body and sends none. The Transport reads it through keptBody,
	// which is the read that has to expire.
	if _, err := fmt.Fprintf(c, "POST http://up.test:%d/x HTTP/1.1\r\nHost: up.test\r\nContent-Length: 1000\r\n\r\n", up.port); err != nil {
		t.Fatal(err)
	}
	// The exchange is torn down mid-response rather than running to completion,
	// so fewer bytes come down than the upstream meant to send.
	if e := h.sink.waitEvent(t, DecisionForward); e.BytesDown >= chunks {
		t.Fatalf("event %+v: whole response relayed, so the stalled guest body never expired", e)
	}
	h.waitConnsInFlight(t, "vm-1", 0)
}

// zeros is an endless source of zero bytes.
type zeros struct{}

func (zeros) Read(b []byte) (int, error) {
	for i := range b {
		b[i] = 0
	}
	return len(b), nil
}

func TestRegisterRefusesAGrant(t *testing.T) {
	h := newHarness(t, "up.test", nil)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(h.dir, "g.sock"), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	err = h.p.Register("vm-1", "run-a", []byte("grant"), ln)
	var re *control.RefusalError
	if !errors.As(err, &re) || re.Code != control.CodeBadRequest {
		t.Fatalf("got %v", err)
	}
	h.register("vm-1", "run-a")
	ln2, _ := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(h.dir, "d.sock"), Net: "unix"})
	defer ln2.Close()
	if err := h.p.Register("vm-1", "run-b", nil, ln2); !errors.As(err, &re) || re.Code != control.CodeDuplicateVM {
		t.Fatalf("duplicate: %v", err)
	}
}

func TestNonProxyRequestIs400(t *testing.T) {
	h := newHarness(t, "up.test", nil)
	path := h.register("vm-1", "run-a")
	resp, body := roundTrip(t, dial(t, path), "GET /x HTTP/1.1\r\nHost: up.test\r\n\r\n")
	assertRefusal(t, resp, body, 400, DecisionBadRequest, "up.test")
	resp, body = roundTrip(t, dial(t, path), "GET https://up.test/x HTTP/1.1\r\nHost: up.test\r\n\r\n")
	assertRefusal(t, resp, body, 400, DecisionBadRequest, "up.test")
	resp, body = roundTrip(t, dial(t, path), "CONNECT up.test HTTP/1.1\r\nHost: up.test\r\n\r\n")
	assertRefusal(t, resp, body, 400, DecisionBadRequest, "up.test")
}

func TestNewProxyValidatesConfig(t *testing.T) {
	good := Config{
		Allow: allow(t, "up.test"), MaxConnsPerVM: 1, MaxRequestsPerSession: 1,
		Resolver: newResolver(), Credentials: NoCredentials{}, Audit: &recSink{},
	}
	for name, mod := range map[string]func(*Config){
		"allow": func(c *Config) { c.Allow = nil }, "resolver": func(c *Config) { c.Resolver = nil },
		"audit": func(c *Config) { c.Audit = nil }, "creds": func(c *Config) { c.Credentials = nil },
		"conns": func(c *Config) { c.MaxConnsPerVM = 0 }, "reqs": func(c *Config) { c.MaxRequestsPerSession = -1 },
		"idle": func(c *Config) { c.IdleTimeout = -1 },
		"resp": func(c *Config) { c.ResponseHeaderTimeout = -time.Second },
	} {
		c := good
		mod(&c)
		if _, err := NewProxy(c); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	p, err := NewProxy(good)
	if err != nil {
		t.Fatal(err)
	}
	// Zero means the default, never "no bound": a caller who left the field
	// alone must still get a connection bounded in time (#585).
	if p.cfg.IdleTimeout != defaultIdleTimeout || p.cfg.ResponseHeaderTimeout != defaultResponseHeaderTimeout {
		t.Fatalf("defaults = %v, %v", p.cfg.IdleTimeout, p.cfg.ResponseHeaderTimeout)
	}
	p.Close()
}

func TestUpstream101IsRefused(t *testing.T) {
	// The upstream answers 101 although the proxy stripped Upgrade; the raw
	// stream after it must never reach the guest.
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		http.ReadRequest(bufio.NewReader(c))
		io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nRAWSTREAM")
		time.Sleep(200 * time.Millisecond)
	})
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	io.WriteString(c, fmt.Sprintf("GET http://up.test:%d/ws HTTP/1.1\r\nHost: up.test\r\n"+
		"Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n", up.port))
	all, _ := io.ReadAll(c)
	if strings.Contains(string(all), "RAWSTREAM") || strings.Contains(string(all), " 101 ") {
		t.Fatalf("101 stream relayed: %q", all)
	}
	resp, err := http.ReadResponse(bufio.NewReader(strings.NewReader(string(all))), nil)
	if err != nil {
		t.Fatalf("%v: %q", err, all)
	}
	body, _ := io.ReadAll(resp.Body)
	assertRefusal(t, resp, string(body), 502, DecisionUpstreamUnreachable, "up.test")
	h.sink.waitEvent(t, DecisionUpstreamUnreachable)
	for _, e := range h.sink.events() {
		if e.Decision == DecisionForward {
			t.Fatalf("101 audited as forward: %+v", e)
		}
	}
}

func TestTrailersAreScrubbedBothWays(t *testing.T) {
	var upHdr, upTrailer http.Header
	var mu sync.Mutex
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		br := bufio.NewReader(c)
		r, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		io.ReadAll(r.Body)
		mu.Lock()
		upHdr, upTrailer = r.Header.Clone(), r.Trailer.Clone()
		mu.Unlock()
		io.WriteString(c, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"+
			"Trailer: X-Moca-Leak, Proxy-Authenticate, Connection, X-Fine\r\n\r\n"+
			"2\r\nok\r\n0\r\nX-Moca-Leak: up\r\nProxy-Authenticate: up\r\nConnection: up\r\nX-Fine: yes\r\n\r\n")
	})
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	io.WriteString(c, fmt.Sprintf("POST http://up.test:%d/t HTTP/1.1\r\nHost: up.test\r\n"+
		"Transfer-Encoding: chunked\r\nTrailer: X-Moca-Session, Proxy-Authorization, X-Ok\r\n\r\n"+
		"3\r\nabc\r\n0\r\nX-Moca-Session: run-a\r\nProxy-Authorization: Basic Zm9v\r\nX-Ok: 1\r\n\r\n", up.port))
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(b) != "ok" {
		t.Fatalf("%d %q", resp.StatusCode, b)
	}
	for k := range resp.Trailer {
		if k != "X-Fine" {
			t.Fatalf("guest got response trailer %s: %v", k, resp.Trailer)
		}
	}
	if resp.Trailer.Get("X-Fine") != "yes" {
		t.Fatalf("benign response trailer lost: %v", resp.Trailer)
	}
	mu.Lock()
	defer mu.Unlock()
	if upHdr == nil {
		t.Fatal("upstream saw no request")
	}
	if v := upHdr.Get("Trailer"); v != "" {
		t.Fatalf("upstream got Trailer header %q", v)
	}
	for k := range upTrailer {
		t.Fatalf("upstream got request trailer %s: %v", k, upTrailer)
	}
}

// stuckListener reports a non-ErrClosed error from Accept once closed, as a
// misbehaving listener implementation might.
type stuckListener struct {
	closed chan struct{}
	once   sync.Once
}

func (l *stuckListener) Accept() (net.Conn, error) {
	<-l.closed
	return nil, errors.New("listener gone")
}
func (l *stuckListener) Close() error   { l.once.Do(func() { close(l.closed) }); return nil }
func (l *stuckListener) Addr() net.Addr { return &net.UnixAddr{Name: "stuck", Net: "unix"} }

func TestCloseReturnsWhenAcceptKeepsFailing(t *testing.T) {
	h := newHarness(t, "up.test", nil)
	if err := h.p.Register("vm-1", "run-a", nil, &stuckListener{closed: make(chan struct{})}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- h.p.Close() }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close hung: serve spins on a non-ErrClosed accept error")
	}
}
