package egress

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type icReq struct {
	Method, URI string
	Header      http.Header
	Body        string
}

// icUpstream is a TLS HTTP/1.1 server whose certificate is signed by root.
type icUpstream struct {
	srv    *httptest.Server
	port   int
	conns  atomic.Int64
	mu     sync.Mutex
	reqs   []icReq
	custom func(w http.ResponseWriter, r *http.Request)
}

func newICUpstream(t *testing.T, root testCA) *icUpstream {
	t.Helper()
	u := &icUpstream{}
	u.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u.custom != nil {
			u.mu.Lock()
			u.reqs = append(u.reqs, icReq{Method: r.Method, URI: r.RequestURI, Header: r.Header.Clone()})
			u.mu.Unlock()
			u.custom(w, r)
			return
		}
		b, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		u.reqs = append(u.reqs, icReq{Method: r.Method, URI: r.RequestURI, Header: r.Header.Clone(), Body: string(b)})
		u.mu.Unlock()
		fmt.Fprintf(w, "ok:%s", r.URL.Path)
	}))
	u.srv.TLS = &tls.Config{Certificates: []tls.Certificate{root.issue(t, []string{"up.test"}, nil)}}
	u.srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			u.conns.Add(1)
		}
	}
	u.srv.StartTLS()
	t.Cleanup(u.srv.Close)
	u.port = u.srv.Listener.Addr().(*net.TCPAddr).Port
	return u
}

func (u *icUpstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.reqs)
}

func (u *icUpstream) last(t *testing.T) icReq {
	t.Helper()
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.reqs) == 0 {
		t.Fatal("upstream saw no request")
	}
	return u.reqs[len(u.reqs)-1]
}

// icPolicy is a CredentialPolicy the test can change between requests.
type icPolicy struct {
	mu  sync.Mutex
	set []Credential
	n   atomic.Int32
}

func (p *icPolicy) Set(s ...Credential) {
	p.mu.Lock()
	p.set = s
	p.mu.Unlock()
}

func (p *icPolicy) Lookup(_ context.Context, _ Caller, _ string) ([]Credential, error) {
	p.n.Add(1)
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Credential(nil), p.set...), nil
}

type icEnv struct {
	t       *testing.T
	h       *harness
	pol     *icPolicy
	up      *icUpstream
	leaf    *LeafCA
	guestCA testCA
	sock    string
}

type icOpts struct {
	untrusted bool
	mod       func(*Config)
	leafNow   func() time.Time // the leaf CA's clock; time.Now when nil
}

func newICEnv(t *testing.T, o icOpts) *icEnv {
	t.Helper()
	upRoot := newTestCA(t, true)
	certRoot := upRoot
	if o.untrusted {
		certRoot = newTestCA(t, true) // the server's cert is not signed by the root the proxy trusts
	}
	e := &icEnv{t: t, pol: &icPolicy{}, guestCA: newTestCA(t, true)}
	e.up = newICUpstream(t, certRoot)
	var err error
	if e.leaf, err = NewLeafCA(e.guestCA.certPEM, e.guestCA.keyPEM, o.leafNow); err != nil {
		t.Fatal(err)
	}
	e.h = newHarness(t, fmt.Sprintf("up.test:%d", e.up.port), func(c *Config) {
		c.Credentials = e.pol
		c.interceptor = newInterceptor(e.leaf, upRoot.pool())
		c.MaxConnsPerVM = 64
		if o.mod != nil {
			o.mod(c)
		}
	})
	e.h.res.set("up.test", "127.0.0.1")
	e.sock = e.h.register("vm-1", "run-a")
	return e
}

func (e *icEnv) cred(name, prefix string, hs ...Header) Credential {
	return Credential{Name: name, PathPrefix: prefix, Subject: "user-1", Port: e.up.port, Headers: hs}
}

func authHdr(v string) Header { return Header{Name: "Authorization", Value: v} }

type icGuest struct {
	t  *testing.T
	c  net.Conn
	tc *tls.Conn
	br *bufio.Reader
}

// openRaw sends CONNECT and returns the raw conn and the CONNECT reply.
func (e *icEnv) openRaw() (net.Conn, *http.Response) {
	e.t.Helper()
	c := dial(e.t, e.sock)
	fmt.Fprintf(c, "CONNECT up.test:%d HTTP/1.1\r\nHost: up.test:%d\r\n\r\n", e.up.port, e.up.port)
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		e.t.Fatal(err)
	}
	return c, resp
}

func (e *icEnv) open() *icGuest {
	return e.openSNI("up.test", false)
}

func (e *icEnv) openSNI(sni string, skipVerify bool) *icGuest {
	e.t.Helper()
	c := dial(e.t, e.sock)
	connect(e.t, c, fmt.Sprintf("up.test:%d", e.up.port))
	tc := tls.Client(c, &tls.Config{ServerName: sni, RootCAs: e.guestCA.pool(), InsecureSkipVerify: skipVerify})
	return &icGuest{t: e.t, c: c, tc: tc, br: bufio.NewReader(tc)}
}

func (g *icGuest) raw(s string) {
	g.t.Helper()
	if _, err := io.WriteString(g.tc, s); err != nil {
		g.t.Fatal(err)
	}
}

func (g *icGuest) readResp() (*http.Response, string) {
	g.t.Helper()
	resp, err := http.ReadResponse(g.br, nil)
	if err != nil {
		g.t.Fatalf("read response: %v", err)
	}
	b, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		g.t.Fatalf("read body: %v", err)
	}
	return resp, string(b)
}

func (e *icEnv) reqLine(method, target string, extra ...string) string {
	s := fmt.Sprintf("%s %s HTTP/1.1\r\nHost: up.test:%d\r\n", method, target, e.up.port)
	for _, x := range extra {
		s += x + "\r\n"
	}
	return s + "\r\n"
}

func (e *icEnv) get(g *icGuest, target string, extra ...string) (*http.Response, string) {
	g.t.Helper()
	g.raw(e.reqLine("GET", target, extra...))
	return g.readResp()
}

// expectClosed asserts the next read on the guest ends (EOF or an error).
func (g *icGuest) expectClosed() {
	g.t.Helper()
	g.c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := g.br.ReadByte(); err == nil {
		g.t.Fatal("conn still open")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		g.t.Fatal("conn not closed")
	}
}

func TestInterceptInjectsAndOverwritesPlaceholder(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/", authHdr("Basic dG9rZW4=")))
	g := e.open()
	resp, body := e.get(g, "/repos", "Authorization: Bearer moca-placeholder")
	if resp.StatusCode != 200 || body != "ok:/repos" {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	r := e.up.last(t)
	if got := r.Header.Values("Authorization"); len(got) != 1 || got[0] != "Basic dG9rZW4=" {
		t.Fatalf("upstream Authorization %q", got)
	}
	for k, vs := range r.Header {
		for _, v := range vs {
			if strings.Contains(v, "moca-placeholder") {
				t.Fatalf("placeholder reached upstream in %s", k)
			}
		}
	}
	ev := e.h.sink.waitEvent(t, DecisionCredentialInjected)
	if ev.Credential != "gh" || ev.Sub != "user-1" || ev.Path != "/repos" || ev.Status != 200 || ev.Host != "up.test" {
		t.Fatalf("event %+v", ev)
	}
}

func TestInterceptSetsAbsentHeader(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer real")))
	g := e.open()
	if resp, _ := e.get(g, "/x"); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	if got := e.up.last(t).Header.Get("Authorization"); got != "Bearer real" {
		t.Fatalf("Authorization %q", got)
	}
}

func TestInterceptStripsProxyAndMocaHeaders(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer real")))
	g := e.open()
	e.get(g, "/x", "Proxy-Authorization: Basic eA==", "Proxy-Tenant: t", "X-Moca-Vm: vm-9",
		"Connection: X-Hop", "X-Hop: 1", "X-Keep: yes")
	h := e.up.last(t).Header
	for _, k := range []string{"Proxy-Authorization", "Proxy-Tenant", "X-Moca-Vm", "X-Hop"} {
		if h.Get(k) != "" {
			t.Errorf("%s reached upstream", k)
		}
	}
	if h.Get("X-Keep") != "yes" {
		t.Error("ordinary header dropped")
	}
}

func TestInterceptUpstreamUnverified502(t *testing.T) {
	e := newICEnv(t, icOpts{untrusted: true})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer real")))
	c, resp := e.openRaw()
	defer c.Close()
	if resp.StatusCode != 502 || resp.Header.Get("X-Moca-Egress-Error") != DecisionUpstreamUnverified {
		t.Fatalf("CONNECT reply %d %q", resp.StatusCode, resp.Header.Get("X-Moca-Egress-Error"))
	}
	e.h.sink.waitEvent(t, DecisionUpstreamUnverified)
	if n := e.leaf.cached(); n != 0 {
		t.Fatalf("%d leaves minted", n)
	}
	if e.up.count() != 0 {
		t.Fatal("request reached upstream")
	}
}

func TestInterceptSNIMismatchClosed(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer real")))
	g := e.openSNI("other.test", true)
	if err := g.tc.Handshake(); err == nil {
		t.Fatal("handshake with a foreign SNI succeeded")
	}
	e.h.sink.waitEvent(t, DecisionMisdirected)
	if e.up.count() != 0 {
		t.Fatal("request reached upstream")
	}
}

func TestInterceptLeafUnavailable503(t *testing.T) {
	var expired atomic.Bool // set after setup: NewLeafCA refuses an expired CA
	e := newICEnv(t, icOpts{leafNow: func() time.Time {
		if expired.Load() {
			return time.Now().Add(49 * time.Hour) // past newTestCA's NotAfter
		}
		return time.Now()
	}})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer real")))
	expired.Store(true)
	g := e.open()
	if err := g.tc.Handshake(); err == nil {
		t.Fatal("handshake succeeded with an expired interception CA")
	}
	ev := e.h.sink.waitEvent(t, DecisionLeafUnavailable)
	if ev.Status != 503 || ev.Method != http.MethodConnect || ev.Host != "up.test" || ev.DialAddr == "" {
		t.Fatalf("event %+v", ev)
	}
	if e.up.count() != 0 {
		t.Fatal("request reached upstream")
	}
}

func TestInterceptHostMismatch421(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer real")))
	g := e.open()
	g.raw("GET / HTTP/1.1\r\nHost: other.test\r\n\r\n")
	resp, _ := g.readResp()
	if resp.StatusCode != 421 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	e.h.sink.waitEvent(t, DecisionMisdirected)
	g.expectClosed()
	if e.up.count() != 0 {
		t.Fatal("request reached upstream")
	}
}

func TestInterceptRevokedMidConnection(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer real")))
	g := e.open()
	if resp, _ := e.get(g, "/a"); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	e.pol.Set()
	resp, body := e.get(g, "/a")
	if resp.StatusCode != 401 || !strings.Contains(body, "credential_revoked") {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	e.h.sink.waitEvent(t, DecisionCredentialRevoked)
	g.expectClosed()
	if e.up.count() != 1 {
		t.Fatalf("upstream saw %d requests", e.up.count())
	}
}

func TestInterceptRevokedNoFallback(t *testing.T) {
	e := newICEnv(t, icOpts{})
	root, a := e.cred("root", "/", authHdr("Bearer R")), e.cred("a", "/a", authHdr("Bearer A"))
	e.pol.Set(root, a)
	g := e.open()
	e.get(g, "/a/x")
	if got := e.up.last(t).Header.Get("Authorization"); got != "Bearer A" {
		t.Fatalf("/a/x carried %q", got)
	}
	e.get(g, "/b")
	if got := e.up.last(t).Header.Get("Authorization"); got != "Bearer R" {
		t.Fatalf("/b carried %q", got)
	}
	e.pol.Set(root) // /a is dropped, / stays
	e.get(g, "/b")
	if got := e.up.last(t).Header.Get("Authorization"); got != "Bearer R" {
		t.Fatalf("/b after dropping /a carried %q", got)
	}
	n := e.up.count()
	resp, body := e.get(g, "/a/x")
	if resp.StatusCode != 401 || !strings.Contains(body, "credential_revoked") {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	if e.up.count() != n {
		t.Fatal("revoked request reached upstream, possibly with R")
	}
	g.expectClosed()
}

func TestInterceptSelectsByPrefix(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(
		e.cred("gh", "/github", authHdr("Bearer A")),
		e.cred("jira", "/jira", authHdr("Bearer B1"), Header{Name: "X-Api-Key", Value: "B2"}),
	)
	g := e.open()
	e.get(g, "/github/x")
	if h := e.up.last(t).Header; h.Get("Authorization") != "Bearer A" || h.Get("X-Api-Key") != "" {
		t.Fatalf("/github/x headers %v", h)
	}
	e.get(g, "/jira/y")
	if h := e.up.last(t).Header; h.Get("Authorization") != "Bearer B1" || h.Get("X-Api-Key") != "B2" {
		t.Fatalf("/jira/y headers %v", h)
	}
	e.get(g, "/docs", "Authorization: Bearer guest-own", "X-Api-Key: guest-key")
	if h := e.up.last(t).Header; h.Get("Authorization") != "Bearer guest-own" || h.Get("X-Api-Key") != "guest-key" {
		// A request no element matches is forwarded with nothing injected and
		// ordinary scrubbing only (spec 5.2): the guest's own headers pass.
		t.Fatalf("/docs headers %v", h)
	}
	ev := e.h.sink.waitEvent(t, DecisionForward)
	if ev.Path != "/docs" || ev.Credential != "" {
		t.Fatalf("forward event %+v", ev)
	}
}

func TestInterceptRefusesTraversalWhenPathScoped(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/github", authHdr("Bearer A")), e.cred("jira", "/jira", authHdr("Bearer B")))
	for _, target := range []string{
		"/github/../jira", "/github/%2e%2e/jira", "/github/%252e%252e/jira", "/github%2Fjira",
		"/github/..;/jira", "/github;x/../jira", `/github\jira`, "/github/./x",
		"//jira/x", "/github//x", "/github#/x",
	} {
		g := e.open()
		g.raw(strings.Replace(e.reqLine("GET", "X"), "X", target, 1))
		resp, body := g.readResp()
		if resp.StatusCode != 400 || !strings.Contains(body, "bad_request") {
			t.Errorf("%q: %d %q", target, resp.StatusCode, body)
		}
	}
	if e.up.count() != 0 {
		t.Fatalf("%d traversal requests reached upstream", e.up.count())
	}
	// A query string is not the path.
	g := e.open()
	if resp, _ := e.get(g, "/github/x?a=1;b=%2e%2e"); resp.StatusCode != 200 {
		t.Fatalf("query with ; and %%: %d", resp.StatusCode)
	}
}

func TestInterceptRefusesTrace(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.up.custom = func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, r.Header) }
	e.pol.Set(e.cred("gh", "/github", authHdr("Bearer s3cr3t-trace")))
	for _, m := range []string{"TRACE", "track"} {
		g := e.open()
		g.raw(e.reqLine(m, "/github/x"))
		resp, body := g.readResp()
		if resp.StatusCode != 405 || strings.Contains(body, "s3cr3t-trace") {
			t.Errorf("%s: %d %q", m, resp.StatusCode, body)
		}
		g.expectClosed()
	}
	if e.up.count() != 0 {
		t.Fatalf("%d TRACE requests reached upstream", e.up.count())
	}
}

func TestInterceptSkipsEarlyHints(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.up.custom = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Link", "</a.css>; rel=preload")
		w.WriteHeader(http.StatusEarlyHints)
		io.WriteString(w, "fin")
	}
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer R")))
	g := e.open()
	resp, body := e.get(g, "/x")
	if resp.StatusCode != 200 || body != "fin" {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	if e.up.last(t).Header.Get("Authorization") != "Bearer R" {
		t.Fatal("credential not injected")
	}
}

func TestInterceptRootOnlyForwardsDotSegments(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer R")))
	for _, target := range []string{"/a/../b", "/a;x", "/a//b"} {
		g := e.open()
		if resp, _ := e.get(g, target); resp.StatusCode != 200 {
			t.Errorf("%q: %d", target, resp.StatusCode)
		}
		if got := e.up.last(t).Header.Get("Authorization"); got != "Bearer R" {
			t.Errorf("%q carried %q", target, got)
		}
	}
}

func TestInterceptStreamingResponseNotCut(t *testing.T) {
	e := newICEnv(t, icOpts{})
	release := make(chan struct{})
	e.up.custom = func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/events" {
			io.WriteString(w, "ok")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: 1\n\n")
		w.(http.Flusher).Flush()
		<-release
		io.WriteString(w, "data: 2\n\n")
	}
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer R")))
	g := e.open()
	g.raw(e.reqLine("GET", "/events"))
	resp, err := http.ReadResponse(g.br, nil)
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil || line != "data: 1\n" {
		t.Fatalf("first event %q, %v", line, err)
	}
	e.pol.Set() // revoked mid-stream
	close(release)
	rest, err := io.ReadAll(resp.Body)
	if err != nil || !strings.Contains(string(rest), "data: 2") {
		t.Fatalf("stream cut: %q, %v", rest, err)
	}
	g2, body := e.get(g, "/next")
	if g2.StatusCode != 401 || !strings.Contains(body, "credential_revoked") {
		t.Fatalf("next request %d %q", g2.StatusCode, body)
	}
}

func TestInterceptKeepAliveSameCredential(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer R")))
	g := e.open()
	for i := 0; i < 3; i++ {
		if resp, _ := e.get(g, fmt.Sprintf("/r%d", i)); resp.StatusCode != 200 {
			t.Fatal(resp.StatusCode)
		}
		if got := e.up.last(t).Header.Get("Authorization"); got != "Bearer R" {
			t.Fatalf("request %d carried %q", i, got)
		}
	}
	if e.up.count() != 3 || e.up.conns.Load() != 1 {
		t.Fatalf("%d requests over %d upstream conns", e.up.count(), e.up.conns.Load())
	}
}

func TestInterceptExpectContinue(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer R")))
	g := e.open()
	g.raw(e.reqLine("PUT", "/up", "Content-Length: 5", "Expect: 100-continue"))
	g.c.SetReadDeadline(time.Now().Add(3 * time.Second))
	interim, err := http.ReadResponse(g.br, nil)
	if err != nil || interim.StatusCode != 100 {
		t.Fatalf("interim: %v %v", interim, err)
	}
	g.raw("hello")
	resp, _ := g.readResp()
	if resp.StatusCode != 200 {
		t.Fatalf("final %d", resp.StatusCode)
	}
	if r := e.up.last(t); r.Body != "hello" || r.Header.Get("Authorization") != "Bearer R" {
		t.Fatalf("upstream got %+v", r)
	}
}

// genBody yields n bytes without holding them, counting what is read.
type genBody struct {
	left int64
	n    *atomic.Int64
}

func (g *genBody) Read(p []byte) (int, error) {
	if g.left <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > g.left {
		p = p[:g.left]
	}
	g.left -= int64(len(p))
	g.n.Add(int64(len(p)))
	return len(p), nil
}

func TestInterceptStreamsLargeBody(t *testing.T) {
	const size = 64 << 20
	e := newICEnv(t, icOpts{})
	var got atomic.Int64
	e.up.custom = func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, countingBody{ReadCloser: r.Body, n: &got})
		fmt.Fprintf(w, "%d", n)
	}
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer R")))
	g := e.open()

	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	var peak atomic.Uint64
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		var m runtime.MemStats
		for {
			select {
			case <-stop:
				return
			case <-time.After(25 * time.Millisecond):
				runtime.ReadMemStats(&m)
				if m.HeapInuse > peak.Load() {
					peak.Store(m.HeapInuse)
				}
			}
		}
	}()

	var sent atomic.Int64
	req, _ := http.NewRequest("POST", fmt.Sprintf("https://up.test:%d/big", e.up.port),
		countingBody{ReadCloser: io.NopCloser(&genBody{left: size, n: &sent}), n: new(atomic.Int64)})
	req.ContentLength = -1 // chunked
	if err := req.Write(g.tc); err != nil {
		t.Fatal(err)
	}
	resp, body := g.readResp()
	close(stop)
	<-done
	if resp.StatusCode != 200 || body != fmt.Sprint(size) {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	if sent.Load() != size || got.Load() != size {
		t.Fatalf("sent %d, upstream received %d", sent.Load(), got.Load())
	}
	if grow := int64(peak.Load()) - int64(base.HeapInuse); grow > 16<<20 {
		t.Fatalf("heap grew %d MiB while streaming", grow>>20)
	}
}

func TestInterceptAuditNoValue(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh-main", "/", authHdr("Bearer s3cr3t-token-value")))
	g := e.open()
	e.get(g, "/x?token=q-secret")
	e.h.sink.waitEvent(t, DecisionCredentialInjected)
	js := e.h.sink.jsonText()
	if !strings.Contains(js, DecisionCredentialInjected) || !strings.Contains(js, "gh-main") {
		t.Fatalf("audit lacks decision or name: %s", js)
	}
	if strings.Contains(js, "s3cr3t-token-value") || strings.Contains(js, "q-secret") {
		t.Fatalf("audit leaked a value: %s", js)
	}
}

func TestInterceptResponseHeaderTimeout(t *testing.T) {
	e := newICEnv(t, icOpts{mod: func(c *Config) {
		c.ResponseHeaderTimeout = 300 * time.Millisecond
		c.IdleTimeout = time.Minute
	}})
	release := make(chan struct{})
	e.up.custom = func(w http.ResponseWriter, r *http.Request) { <-release }
	t.Cleanup(func() { close(release) }) // runs before the server's Close
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer R")))
	g := e.open()
	start := time.Now()
	g.raw(e.reqLine("GET", "/hang"))
	g.c.SetReadDeadline(time.Now().Add(5 * time.Second))
	resp, err := http.ReadResponse(g.br, nil)
	if err == nil {
		io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != 502 {
			t.Fatalf("status %d", resp.StatusCode)
		}
	}
	g.expectClosed()
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("took %v to give up on a silent upstream", d)
	}
}

func TestInterceptIdleGuestEnds(t *testing.T) {
	e := newICEnv(t, icOpts{mod: func(c *Config) { c.IdleTimeout = 300 * time.Millisecond }})
	e.pol.Set(e.cred("gh", "/", authHdr("Bearer R")))
	g := e.open()
	if resp, _ := e.get(g, "/x"); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	start := time.Now()
	g.expectClosed()
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("idle conn lived %v", d)
	}
}

func TestInterceptUncoveredKeepsGuestAuthorization(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("gh", "/github", authHdr("Bearer real")))
	g := e.open()
	if resp, _ := e.get(g, "/other", "Authorization: Bearer own"); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	if got := e.up.last(t).Header.Values("Authorization"); len(got) != 1 || got[0] != "Bearer own" {
		t.Fatalf("upstream Authorization %q", got)
	}
}

// Both refusals after injection, a closed conn and an unasked 101, keep the
// credential and subject in the audit.
func TestInterceptUpstreamFailsAfterInjectionKeepsCredentialInAudit(t *testing.T) {
	for name, reply := range map[string]string{"closed": "", "101": "HTTP/1.1 101 Switching Protocols\r\n\r\n"} {
		t.Run(name, func(t *testing.T) {
			e := newICEnv(t, icOpts{})
			e.up.custom = func(w http.ResponseWriter, r *http.Request) {
				hj, _ := w.(http.Hijacker)
				c, _, err := hj.Hijack()
				if err == nil {
					io.WriteString(c, reply)
					c.Close()
				}
			}
			e.pol.Set(e.cred("gh", "/", authHdr("Bearer real")))
			g := e.open()
			g.raw(e.reqLine("GET", "/x"))
			ev := e.h.sink.waitEvent(t, DecisionUpstreamUnreachable)
			if ev.Credential != "gh" || ev.Sub != "user-1" {
				t.Fatalf("event %+v", ev)
			}
			if strings.Contains(e.h.sink.jsonText(), "Bearer real") {
				t.Fatal("audit leaked a value")
			}
		})
	}
}

func TestInterceptMatchedDropsGuestAuthorization(t *testing.T) {
	e := newICEnv(t, icOpts{})
	e.pol.Set(e.cred("keyed", "/", Header{Name: "X-Api-Key", Value: "real-key"}))
	g := e.open()
	if resp, _ := e.get(g, "/x", "Authorization: Bearer moca-placeholder", "X-Api-Key: guest"); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	h := e.up.last(t).Header
	if got := h.Values("X-Api-Key"); len(got) != 1 || got[0] != "real-key" {
		t.Fatalf("upstream X-Api-Key %q", got)
	}
	if got := h.Values("Authorization"); len(got) != 0 {
		t.Fatalf("upstream saw %d Authorization header(s), want none", len(got))
	}
}
