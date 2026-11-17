package egress

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type cpFake struct {
	srv   *httptest.Server
	calls atomic.Int64
	mu    sync.Mutex
	h     http.HandlerFunc
	last  struct {
		auth string
		body map[string]string
	}
}

func newCPFake(t *testing.T, h http.HandlerFunc) *cpFake {
	f := &cpFake{h: h}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		f.mu.Lock()
		f.last.auth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&f.last.body)
		hh := f.h
		f.mu.Unlock()
		if r.URL.Path != "/v1/egress/credential" || r.Method != http.MethodPost {
			http.Error(w, "bad", 400)
			return
		}
		hh(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *cpFake) set(h http.HandlerFunc) { f.mu.Lock(); f.h = h; f.mu.Unlock() }

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func (f *cpFake) client(t *testing.T, clk *clock) *CPCredentials {
	pool := x509.NewCertPool()
	pool.AddCert(f.srv.Certificate())
	o := CPCredentialsOptions{URL: f.srv.URL, Token: "tok", RootCAs: pool, Timeout: 2 * time.Second, NoneTTL: time.Minute}
	if clk != nil {
		o.Now = clk.now
	}
	c, err := NewCPCredentials(o)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func okBody(ttl int, creds string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"subject":"alice","ttlSeconds":%d,"credentials":[%s]}`, ttl, creds)
	}
}

const gh = `{"name":"gh","port":443,"pathPrefix":"/","headers":[{"name":"Authorization","value":"Bearer SECRETVAL"}],"expiresAt":null}`

var cl1 = Caller{SessionID: "sbx-00000000000000000000000001"}

func TestLookupFoundCachedForTTL(t *testing.T) {
	f := newCPFake(t, okBody(60, gh))
	clk := &clock{t: time.Unix(1000, 0)}
	c := f.client(t, clk)
	for i := 0; i < 2; i++ {
		if _, err := c.Lookup(context.Background(), cl1, "api.github.com"); err != nil {
			t.Fatal(err)
		}
	}
	if f.calls.Load() != 1 {
		t.Fatalf("calls = %d", f.calls.Load())
	}
	if f.last.auth != "Bearer tok" || f.last.body["sandbox"] != cl1.SessionID || f.last.body["host"] != "api.github.com" {
		t.Fatalf("request = %q %v", f.last.auth, f.last.body)
	}
	clk.add(61 * time.Second)
	if _, err := c.Lookup(context.Background(), cl1, "api.github.com"); err != nil {
		t.Fatal(err)
	}
	if f.calls.Load() != 2 {
		t.Fatalf("calls = %d", f.calls.Load())
	}
}

func TestLookupDecodesSet(t *testing.T) {
	jira := `{"name":"jira","port":443,"pathPrefix":"/jira","headers":[{"name":"X-A","value":"a"},{"name":"X-B","value":"b"}],"expiresAt":"2030-01-01T00:00:00Z"}`
	gh2 := `{"name":"gh","port":8443,"pathPrefix":"/github","headers":[{"name":"Authorization","value":"v"}],"expiresAt":null}`
	f := newCPFake(t, okBody(60, jira+","+gh2))
	set, err := f.client(t, nil).Lookup(context.Background(), cl1, "x.example")
	if err != nil {
		t.Fatal(err)
	}
	if len(set) != 2 {
		t.Fatalf("set = %d", len(set))
	}
	a, b := set[0], set[1]
	if a.Name != "jira" || a.Port != 443 || a.PathPrefix != "/jira" || a.Subject != "alice" || len(a.Headers) != 2 ||
		a.Headers[1] != (Header{"X-B", "b"}) || a.ExpiresAt.IsZero() {
		t.Fatalf("a = %#v", a.Headers)
	}
	if b.Port != 8443 || b.PathPrefix != "/github" || b.Subject != "alice" || !b.ExpiresAt.IsZero() {
		t.Fatalf("b = %v", b.PathPrefix)
	}
}

func TestLookupRejectsMalformedElement(t *testing.T) {
	el := func(port, prefix, headers string) string {
		return fmt.Sprintf(`{"name":"n","port":%s,"pathPrefix":%s,"headers":%s,"expiresAt":null}`, port, prefix, headers)
	}
	h1 := `[{"name":"A","value":"v"}]`
	cases := map[string]string{
		"zero headers":   el("443", `"/"`, `[]`),
		"five headers":   el("443", `"/"`, `[{"name":"A","value":"v"},{"name":"B","value":"v"},{"name":"C","value":"v"},{"name":"D","value":"v"},{"name":"E","value":"v"}]`),
		"CR in value":    el("443", `"/"`, `[{"name":"A","value":"a\rb"}]`),
		"LF in value":    el("443", `"/"`, `[{"name":"A","value":"a\nb"}]`),
		"NUL in value":   el("443", `"/"`, `[{"name":"A","value":"a\u0000b"}]`),
		"LF in name":     el("443", `"/"`, `[{"name":"A\nB","value":"v"}]`),
		"empty name":     el("443", `"/"`, `[{"name":"","value":"v"}]`),
		"port 0":         el("0", `"/"`, h1),
		"port 65536":     el("65536", `"/"`, h1),
		"no slash":       el("443", `"jira"`, h1),
		"percent":        el("443", `"/a%2fb"`, h1),
		"backslash":      el("443", `"/a\\b"`, h1),
		"semicolon":      el("443", `"/a;b"`, h1),
		"question":       el("443", `"/a?b"`, h1),
		"hash":           el("443", `"/a#b"`, h1),
		"double slash":   el("443", `"/a//b"`, h1),
		"dot segment":    el("443", `"/a/./b"`, h1),
		"dotdot":         el("443", `"/a/../b"`, h1),
		"trailing slash": el("443", `"/a/"`, h1),
		"not json":       `"x"`,
		"name a/b":       el("443", `"/"`, `[{"name":"a/b","value":"v"}]`),
		"name too long":  el("443", `"/"`, `[{"name":"`+strings.Repeat("a", 65)+`","value":"v"}]`),
		"proxy- prefix":  el("443", `"/"`, `[{"name":"Proxy-Foo","value":"v"}]`),
		"x-moca- prefix": el("443", `"/"`, `[{"name":"X-Moca-Vm","value":"v"}]`),
		"duplicate name": el("443", `"/"`, `[{"name":"X-A","value":"1"},{"name":"x-a","value":"2"}]`),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			f := newCPFake(t, okBody(60, gh+","+body))
			c := f.client(t, nil)
			for i := 0; i < 2; i++ {
				if _, err := c.Lookup(context.Background(), cl1, "x.example"); err == nil {
					t.Fatal("want error")
				} else if strings.Contains(err.Error(), "SECRETVAL") {
					t.Fatal("error leaks a value")
				}
			}
			if f.calls.Load() != 2 {
				t.Fatalf("calls = %d, error was cached", f.calls.Load())
			}
		})
	}
}

func TestLookupNoneBothCodesCached(t *testing.T) {
	for _, code := range []string{"no_credential", "sandbox_not_found"} {
		f := newCPFake(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(404)
			fmt.Fprintf(w, `{"error":%q}`, code)
		})
		clk := &clock{t: time.Unix(1000, 0)}
		c := f.client(t, clk)
		for i := 0; i < 2; i++ {
			set, err := c.Lookup(context.Background(), cl1, "x.example")
			if err != nil || len(set) != 0 {
				t.Fatalf("%s: %v %v", code, set, err)
			}
		}
		if f.calls.Load() != 1 {
			t.Fatalf("%s: calls = %d", code, f.calls.Load())
		}
		clk.add(61 * time.Second)
		_, _ = c.Lookup(context.Background(), cl1, "x.example")
		if f.calls.Load() != 2 {
			t.Fatalf("%s: not expired, calls = %d", code, f.calls.Load())
		}
	}
}

func TestLookupOtherStatusesAreErrorsNotCached(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
	}{{500, `{"error":"destination_ambiguous"}`}, {404, `{"error":"other"}`}, {404, `junk`}, {401, `{}`}, {302, ``}} {
		f := newCPFake(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(tc.status); fmt.Fprint(w, tc.body) })
		c := f.client(t, nil)
		for i := 0; i < 2; i++ {
			if _, err := c.Lookup(context.Background(), cl1, "x.example"); err == nil {
				t.Fatalf("%d %s: want error", tc.status, tc.body)
			}
		}
		if f.calls.Load() != 2 {
			t.Fatalf("%d: calls = %d", tc.status, f.calls.Load())
		}
	}
}

func TestLookupErrorNotCachedAndWaitersRetry(t *testing.T) {
	release := make(chan struct{})
	f := newCPFake(t, func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.WriteHeader(500)
	})
	c := f.client(t, nil)
	var wg sync.WaitGroup
	var errs atomic.Int64
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Lookup(context.Background(), cl1, "x.example"); err != nil {
				errs.Add(1)
			}
		}()
	}
	for f.calls.Load() < 1 {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond) // let the other 49 queue behind the flight
	close(release)
	wg.Wait()
	if errs.Load() != 50 || f.calls.Load() != 1 {
		t.Fatalf("errs = %d, calls = %d", errs.Load(), f.calls.Load())
	}
	f.set(okBody(60, gh))
	if set, err := c.Lookup(context.Background(), cl1, "x.example"); err != nil || len(set) != 1 {
		t.Fatalf("%v %v", set, err)
	}
	if f.calls.Load() != 2 {
		t.Fatalf("calls = %d", f.calls.Load())
	}
}

func TestLookupTimeout(t *testing.T) {
	f := newCPFake(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	})
	pool := x509.NewCertPool()
	pool.AddCert(f.srv.Certificate())
	c, err := NewCPCredentials(CPCredentialsOptions{URL: f.srv.URL, Token: "t", RootCAs: pool, Timeout: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err := c.Lookup(context.Background(), cl1, "x.example"); err == nil {
		t.Fatal("want error")
	}
	if time.Since(start) > time.Second {
		t.Fatal("did not time out")
	}
}

func TestLookupKeyNormalised(t *testing.T) {
	f := newCPFake(t, okBody(60, gh))
	c := f.client(t, nil)
	other := Caller{SessionID: "sbx-00000000000000000000000002"}
	ctx := context.Background()
	_, _ = c.Lookup(ctx, cl1, "api.github.com")
	_, _ = c.Lookup(ctx, other, "api.github.com")
	if f.calls.Load() != 2 {
		t.Fatalf("calls = %d", f.calls.Load())
	}
	_, _ = c.Lookup(ctx, cl1, "api.github.com")
	_, _ = c.Lookup(ctx, other, "api.github.com")
	if f.calls.Load() != 2 {
		t.Fatalf("calls = %d", f.calls.Load())
	}
}

func TestCredentialStringRedacted(t *testing.T) {
	cred := Credential{Name: "gh", Subject: "alice", PathPrefix: "/", Port: 443, Headers: []Header{{"Authorization", "SECRETVAL"}}}
	for _, v := range []any{cred, &cred, cred.Headers[0], cred.Headers} {
		s := fmt.Sprintf("%v %+v %#v %s", v, v, v, v)
		if strings.Contains(s, "SECRETVAL") {
			t.Fatalf("leak: %s", s)
		}
	}
	if s := fmt.Sprintf("%v", cred); !strings.Contains(s, "Authorization") || !strings.Contains(s, "<redacted>") {
		t.Fatalf("string = %s", s)
	}
}

func TestTTLClamped(t *testing.T) {
	for _, tc := range []struct {
		ttl  int
		live time.Duration
		dead time.Duration
	}{{1, 4 * time.Second, 6 * time.Second}, {9999, 299 * time.Second, 301 * time.Second}} {
		f := newCPFake(t, okBody(tc.ttl, gh))
		clk := &clock{t: time.Unix(1000, 0)}
		c := f.client(t, clk)
		_, _ = c.Lookup(context.Background(), cl1, "x.example")
		clk.add(tc.live)
		_, _ = c.Lookup(context.Background(), cl1, "x.example")
		if f.calls.Load() != 1 {
			t.Fatalf("ttl %d: expired early", tc.ttl)
		}
		clk.add(tc.dead - tc.live)
		_, _ = c.Lookup(context.Background(), cl1, "x.example")
		if f.calls.Load() != 2 {
			t.Fatalf("ttl %d: not expired", tc.ttl)
		}
	}
}

// The server's TTL counts from when it answered, which is after the request
// left; the cache must count from the request's start, not from when the
// slow answer arrived, or an entry outlives the server's word by the call's
// duration (up to the timeout). The fake clock moves on inside the handler to
// stand in for a slow call.
func TestTTLMeasuredFromRequestStart(t *testing.T) {
	clk := &clock{t: time.Unix(1000, 0)}
	slow := func(w http.ResponseWriter, r *http.Request) {
		clk.add(2 * time.Second)
		okBody(10, gh)(w, r)
	}
	f := newCPFake(t, slow)
	c := f.client(t, clk)
	if _, err := c.Lookup(context.Background(), cl1, "x.example"); err != nil {
		t.Fatal(err)
	}
	// 11s after the request started, 9s after the answer arrived: past the
	// server's 10s, so the entry must have lapsed.
	clk.add(9 * time.Second)
	f.set(okBody(10, gh)) // the refetch is not slow
	if _, err := c.Lookup(context.Background(), cl1, "x.example"); err != nil {
		t.Fatal(err)
	}
	if n := f.calls.Load(); n != 2 {
		t.Fatalf("calls = %d, want 2: the entry outlived the server's TTL by the call's duration", n)
	}
}

func TestTTLClampedToExpiresAt(t *testing.T) {
	clk := &clock{t: time.Unix(1000, 0)}
	exp := clk.now().Add(10 * time.Second).UTC().Format(time.RFC3339)
	f := newCPFake(t, okBody(300, strings.Replace(gh, `"expiresAt":null`, `"expiresAt":"`+exp+`"`, 1)))
	c := f.client(t, clk)
	_, _ = c.Lookup(context.Background(), cl1, "x.example")
	clk.add(11 * time.Second)
	_, _ = c.Lookup(context.Background(), cl1, "x.example")
	if f.calls.Load() != 2 {
		t.Fatalf("calls = %d", f.calls.Load())
	}
}

func TestCacheBounded(t *testing.T) {
	f := newCPFake(t, okBody(60, gh))
	c := f.client(t, nil)
	for i := 0; i < maxCacheEntries+10; i++ {
		_, _ = c.Lookup(context.Background(), cl1, fmt.Sprintf("h%d.example", i))
	}
	c.mu.Lock()
	n := len(c.cache)
	c.mu.Unlock()
	if n > maxCacheEntries {
		t.Fatalf("entries = %d", n)
	}
}

func TestNewCPCredentialsURLRules(t *testing.T) {
	for url, ok := range map[string]bool{
		"https://cp.example": true, "http://127.0.0.1:8080": true,
		"http://cp.example": false, "ftp://x": false, "": false, "http://localhost:1": false,
	} {
		_, err := NewCPCredentials(CPCredentialsOptions{URL: url, Token: "t"})
		if (err == nil) != ok {
			t.Errorf("%q: err = %v", url, err)
		}
	}
	if _, err := NewCPCredentials(CPCredentialsOptions{URL: "https://cp.example"}); err == nil {
		t.Error("empty token accepted")
	}
}

func TestLookupRefusesCPRefusedHeaderNames(t *testing.T) {
	for _, n := range []string{"host", "Connection", "content-length", "Transfer-Encoding", "TE", "trailer",
		"upgrade", "Keep-Alive", "Cookie", "set-cookie"} {
		t.Run(n, func(t *testing.T) {
			el := fmt.Sprintf(`{"name":"n","port":443,"pathPrefix":"/","headers":[{"name":%q,"value":"v"}],"expiresAt":null}`, n)
			f := newCPFake(t, okBody(60, gh+","+el))
			c := f.client(t, nil)
			for i := 0; i < 2; i++ {
				if _, err := c.Lookup(context.Background(), cl1, "x.example"); err == nil {
					t.Fatal("want error")
				}
			}
			if f.calls.Load() != 2 {
				t.Fatalf("calls = %d, error was cached", f.calls.Load())
			}
		})
	}
}

func TestLookupDropsExpiredElements(t *testing.T) {
	clk := &clock{t: time.Unix(1000, 0)}
	at := func(d time.Duration) string {
		return `"expiresAt":"` + clk.now().Add(d).UTC().Format(time.RFC3339) + `"`
	}
	with := func(name string, d time.Duration) string {
		return fmt.Sprintf(`{"name":%q,"port":443,"pathPrefix":"/%s","headers":[{"name":"X-A","value":"v"}],%s}`, name, name, at(d))
	}
	t.Run("kept alongside", func(t *testing.T) {
		f := newCPFake(t, okBody(60, with("old", 3*time.Second)+","+with("past", -time.Hour)+","+with("live", time.Hour)))
		set, err := f.client(t, clk).Lookup(context.Background(), cl1, "x.example")
		if err != nil || len(set) != 1 || set[0].Name != "live" {
			t.Fatalf("set = %v err = %v", set, err)
		}
	})
	t.Run("all dropped is an empty set cached at the floor", func(t *testing.T) {
		f := newCPFake(t, okBody(60, with("old", 2*time.Second)))
		c := f.client(t, clk)
		for i := 0; i < 2; i++ {
			set, err := c.Lookup(context.Background(), cl1, "x.example")
			if err != nil || len(set) != 0 {
				t.Fatalf("set = %v err = %v", set, err)
			}
		}
		if f.calls.Load() != 1 {
			t.Fatalf("calls = %d", f.calls.Load())
		}
		clk.add(6 * time.Second)
		_, _ = c.Lookup(context.Background(), cl1, "x.example")
		if f.calls.Load() != 2 {
			t.Fatalf("not expired at the floor, calls = %d", f.calls.Load())
		}
	})
}

func TestLookupNoneTTLs(t *testing.T) {
	notFound := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404); fmt.Fprint(w, body) }
	}
	// refetchAfter reports whether a second lookup after d hits the control plane again.
	refetchAfter := func(t *testing.T, body string, d time.Duration) bool {
		f := newCPFake(t, notFound(body))
		clk := &clock{t: time.Unix(1000, 0)}
		c := f.client(t, clk)
		_, _ = c.Lookup(context.Background(), cl1, "x.example")
		clk.add(d)
		_, _ = c.Lookup(context.Background(), cl1, "x.example")
		return f.calls.Load() == 2
	}
	if refetchAfter(t, `{"error":"no_credential"}`, 59*time.Second) {
		t.Error("no_credential expired before NoneTTL")
	}
	if !refetchAfter(t, `{"error":"no_credential"}`, 61*time.Second) {
		t.Error("no_credential outlived NoneTTL")
	}
	if refetchAfter(t, `{"error":"sandbox_not_found"}`, 4*time.Second) {
		t.Error("sandbox_not_found expired before the floor")
	}
	if !refetchAfter(t, `{"error":"sandbox_not_found"}`, 6*time.Second) {
		t.Error("sandbox_not_found pinned past the floor")
	}
	if !refetchAfter(t, `{"error":"no_credential","ttlSeconds":10}`, 11*time.Second) {
		t.Error("ttlSeconds not honoured")
	}
	if refetchAfter(t, `{"error":"no_credential","ttlSeconds":10}`, 9*time.Second) {
		t.Error("ttlSeconds not honoured (early)")
	}
	if refetchAfter(t, `{"error":"no_credential","ttlSeconds":9999}`, 299*time.Second) {
		t.Error("ttlSeconds not clamped high")
	}
	if !refetchAfter(t, `{"error":"no_credential","ttlSeconds":9999}`, 301*time.Second) {
		t.Error("ttlSeconds not clamped high (late)")
	}
	if !refetchAfter(t, `{"error":"no_credential","ttlSeconds":1}`, 6*time.Second) {
		t.Error("ttlSeconds not clamped low")
	}
}

func TestNewCPCredentialsURLRefusals(t *testing.T) {
	for _, u := range []string{
		"https://user:pw@cp.example", "https://user@cp.example", "https://cp.example?x=1",
		"https://cp.example/?", "https://cp.example#frag", "https://cp.example/api", "https://cp.example/a/",
	} {
		_, err := NewCPCredentials(CPCredentialsOptions{URL: u, Token: "t"})
		if err == nil {
			t.Errorf("%q accepted", u)
		} else if strings.Contains(err.Error(), "pw") {
			t.Errorf("%q: error echoes userinfo: %v", u, err)
		}
	}
	for _, u := range []string{"https://cp.example", "https://cp.example/", "https://cp.example:8443"} {
		c, err := NewCPCredentials(CPCredentialsOptions{URL: u, Token: "t"})
		if err != nil {
			t.Errorf("%q: %v", u, err)
		} else if !strings.HasSuffix(c.endpoint, "/v1/egress/credential") || strings.Contains(c.endpoint, "//v1") {
			t.Errorf("endpoint = %s", c.endpoint)
		}
	}
}
