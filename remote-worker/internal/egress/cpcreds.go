package egress

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	maxCacheEntries = 4096
	minTTL          = 5 * time.Second
	maxTTL          = 300 * time.Second
	maxRespBytes    = 1 << 20
	maxHeaders      = 4
)

// String prints the name only; a value never reaches a log through %v, %+v,
// %s or %#v.
func (h Header) String() string { return h.Name + ": <redacted>" }

// GoString is the %#v form, redacted the same way.
func (h Header) GoString() string { return "egress.Header{" + h.String() + "}" }

// String prints the credential with its header values redacted.
func (c Credential) String() string {
	names := make([]string, len(c.Headers))
	for i, h := range c.Headers {
		names[i] = h.Name + "=<redacted>"
	}
	return fmt.Sprintf("{name=%s subject=%s port=%d pathPrefix=%s headers=[%s]}",
		c.Name, c.Subject, c.Port, c.PathPrefix, strings.Join(names, " "))
}

// GoString is the %#v form, redacted the same way.
func (c Credential) GoString() string { return "egress.Credential" + c.String() }

// CPCredentialsOptions configures NewCPCredentials.
type CPCredentialsOptions struct {
	URL     string         // https only; http is accepted only for 127.0.0.1 (tests)
	Token   string         // the egress token
	RootCAs *x509.CertPool // nil = system roots
	Timeout time.Duration  // per call, default 3s
	NoneTTL time.Duration  // how long no_credential is cached, default 60s (sandbox_not_found: the 5s floor)
	Now     func() time.Time
}

type cpEntry struct {
	set     []Credential
	expires time.Time
}

type cpKey struct{ sandbox, host string }

type cpFlight struct {
	done chan struct{}
	set  []Credential
	err  error
}

// CPCredentials is a CredentialPolicy backed by the control plane's
// POST /v1/egress/credential, with a bounded in-memory TTL cache and
// single-flight per (sandbox, host). Values live in memory only.
type CPCredentials struct {
	endpoint string
	token    string
	timeout  time.Duration
	noneTTL  time.Duration
	now      func() time.Time
	hc       *http.Client

	mu      sync.Mutex
	cache   map[cpKey]cpEntry
	flights map[cpKey]*cpFlight
}

var _ CredentialPolicy = (*CPCredentials)(nil)

// NewCPCredentials validates o and returns the client.
func NewCPCredentials(o CPCredentialsOptions) (*CPCredentials, error) {
	u, err := url.Parse(o.URL)
	if err != nil || u.Host == "" {
		return nil, errors.New("credentials URL is not a valid URL")
	}
	// Refused by shape only; nothing from the URL is echoed (it may carry userinfo).
	if u.User != nil {
		return nil, errors.New("credentials URL must not carry userinfo")
	}
	if u.RawQuery != "" || u.ForceQuery {
		return nil, errors.New("credentials URL must not carry a query")
	}
	if u.Fragment != "" || strings.Contains(o.URL, "#") {
		return nil, errors.New("credentials URL must not carry a fragment")
	}
	if u.Path != "" && u.Path != "/" {
		return nil, errors.New("credentials URL must not carry a path")
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && u.Hostname() == "127.0.0.1":
	default:
		return nil, errors.New("credentials URL must be https")
	}
	if o.Token == "" {
		return nil, errors.New("credentials token is empty")
	}
	if o.Timeout <= 0 {
		o.Timeout = 3 * time.Second
	}
	if o.NoneTTL <= 0 {
		o.NoneTTL = 60 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	tr := &http.Transport{
		Proxy:               nil, // the control plane is reached directly, never via this proxy
		TLSClientConfig:     &tls.Config{RootCAs: o.RootCAs, MinVersion: tls.VersionTLS12},
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: o.Timeout,
	}
	return &CPCredentials{
		endpoint: u.JoinPath("v1", "egress", "credential").String(),
		token:    o.Token,
		timeout:  o.Timeout,
		noneTTL:  o.NoneTTL,
		now:      o.Now,
		hc: &http.Client{
			Transport: tr,
			// Never follow a redirect: the bearer token must go to one place.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		cache:   map[cpKey]cpEntry{},
		flights: map[cpKey]*cpFlight{},
	}, nil
}

// Lookup returns the owner's set for host. A cached answer is served until
// its TTL; concurrent misses share one call; an error is never cached.
func (c *CPCredentials) Lookup(ctx context.Context, cl Caller, host string) ([]Credential, error) {
	k := cpKey{cl.SessionID, host}
	c.mu.Lock()
	if e, ok := c.cache[k]; ok {
		if c.now().Before(e.expires) {
			c.mu.Unlock()
			return append([]Credential(nil), e.set...), nil
		}
		delete(c.cache, k)
	}
	f, inflight := c.flights[k]
	if !inflight {
		f = &cpFlight{done: make(chan struct{})}
		c.flights[k] = f
		go c.fly(k, f)
	}
	c.mu.Unlock()

	select {
	case <-f.done:
		if f.err != nil {
			return nil, f.err
		}
		return append([]Credential(nil), f.set...), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// fly runs the call detached from any one caller's context, so one caller
// going away does not fail the others sharing the flight.
//
// The entry's life is counted from before the call, not from its answer. The
// server's TTL starts when it answered, which is after the request left, so
// counting from the start can only end an entry early; counting from the
// answer would let it outlive the server's word by however long the call took,
// up to the timeout.
func (c *CPCredentials) fly(k cpKey, f *cpFlight) {
	start := c.now()
	set, ttl, err := c.fetch(k)
	c.mu.Lock()
	f.set, f.err = set, err
	if err == nil && ttl > 0 {
		c.insertLocked(k, cpEntry{set: set, expires: start.Add(ttl)})
	}
	delete(c.flights, k)
	c.mu.Unlock()
	close(f.done)
}

func (c *CPCredentials) insertLocked(k cpKey, e cpEntry) {
	if _, ok := c.cache[k]; !ok && len(c.cache) >= maxCacheEntries {
		now := c.now()
		var oldest cpKey
		var oldestAt time.Time
		first := true
		for kk, ee := range c.cache {
			if !now.Before(ee.expires) {
				delete(c.cache, kk)
				continue
			}
			if first || ee.expires.Before(oldestAt) {
				oldest, oldestAt, first = kk, ee.expires, false
			}
		}
		if len(c.cache) >= maxCacheEntries && !first {
			delete(c.cache, oldest)
		}
	}
	c.cache[k] = e
}

type wireHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type wireCredential struct {
	Name       string       `json:"name"`
	Port       int          `json:"port"`
	PathPrefix string       `json:"pathPrefix"`
	Headers    []wireHeader `json:"headers"`
	ExpiresAt  *string      `json:"expiresAt"`
}

type wireResponse struct {
	Subject     string           `json:"subject"`
	TTLSeconds  int              `json:"ttlSeconds"`
	Credentials []wireCredential `json:"credentials"`
}

func (c *CPCredentials) fetch(k cpKey) ([]Credential, time.Duration, error) {
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"sandbox": k.sandbox, "host": k.host})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, 0, errors.New("credential lookup: bad request")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		// url.Error carries the URL only, never a header; still keep it terse.
		return nil, 0, errors.New("credential lookup: control plane unreachable")
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxRespBytes+1))
	if err != nil || len(raw) > maxRespBytes {
		return nil, 0, errors.New("credential lookup: unreadable response")
	}
	switch resp.StatusCode {
	case http.StatusOK:
		return c.decode(raw)
	case http.StatusNotFound:
		var e struct {
			Error      string `json:"error"`
			TTLSeconds *int   `json:"ttlSeconds"`
		}
		if json.Unmarshal(raw, &e) == nil && (e.Error == "no_credential" || e.Error == "sandbox_not_found") {
			// A sandbox that has only just become ready must not be pinned to
			// "none": sandbox_not_found lives for the floor only.
			ttl := c.noneTTL
			if e.Error == "sandbox_not_found" {
				ttl = minTTL
			}
			if e.TTLSeconds != nil { // forward-compatible: honour the server's word
				ttl = clampTTL(*e.TTLSeconds)
			}
			return nil, ttl, nil
		}
	}
	return nil, 0, fmt.Errorf("credential lookup: control plane answered %d", resp.StatusCode)
}

func (c *CPCredentials) decode(raw []byte) ([]Credential, time.Duration, error) {
	var w wireResponse
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, 0, errors.New("credential lookup: undecodable response")
	}
	now := c.now()
	ttl := clampTTL(w.TTLSeconds)
	out := make([]Credential, 0, len(w.Credentials))
	dropped := false
	for i, e := range w.Credentials {
		cred := Credential{Name: e.Name, PathPrefix: e.PathPrefix, Subject: w.Subject, Port: e.Port}
		if err := validElement(e); err != nil {
			return nil, 0, fmt.Errorf("credential lookup: element %d: %w", i, err)
		}
		for _, h := range e.Headers {
			cred.Headers = append(cred.Headers, Header{Name: h.Name, Value: h.Value})
		}
		if e.ExpiresAt != nil {
			t, err := time.Parse(time.RFC3339, *e.ExpiresAt)
			if err != nil {
				return nil, 0, fmt.Errorf("credential lookup: element %d: bad expiresAt", i)
			}
			if !t.IsZero() {
				// An element that lapses within the floor is dropped, not
				// refused: the rest of the set stands (spec 4.2).
				if t.Before(now.Add(minTTL)) {
					dropped = true
					continue
				}
				cred.ExpiresAt = t
				if rem := t.Sub(now); rem < ttl {
					ttl = rem
				}
			}
		}
		out = append(out, cred)
	}
	if dropped && len(out) == 0 {
		ttl = minTTL // everything lapsed: an empty set, rechecked at the floor
	}
	return out, ttl, nil
}

// clampTTL turns a wire TTL in seconds into a duration within [minTTL, maxTTL].
func clampTTL(sec int) time.Duration {
	if sec > int(maxTTL/time.Second) { // also guards overflow
		return maxTTL
	}
	return max(minTTL, time.Duration(sec)*time.Second)
}

// refusedHeaders mirrors REFUSED_HEADERS in
// packages/control-plane/src/egress-binding.ts. Keep the two in step.
var refusedHeaders = map[string]bool{
	"host": true, "connection": true, "content-length": true, "transfer-encoding": true,
	"te": true, "trailer": true, "upgrade": true, "keep-alive": true, "cookie": true, "set-cookie": true,
}

// validHeaderName mirrors HEADER_RE and checkHeader in egress-binding.ts.
func validHeaderName(n string) bool {
	if len(n) < 1 || len(n) > 64 {
		return false
	}
	for i := 0; i < len(n); i++ {
		c := n[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	l := strings.ToLower(n)
	return !refusedHeaders[l] && !strings.HasPrefix(l, "proxy-") && !strings.HasPrefix(l, "x-moca-")
}

// validElement mirrors the control plane's write-time grammar
// (packages/control-plane/src/egress-binding.ts: checkEgressBindings), so a bad
// stored value can never become a selection the proxy trusts. Errors never
// echo a header value.
func validElement(e wireCredential) error {
	if n := len(e.Headers); n < 1 || n > maxHeaders {
		return fmt.Errorf("%d headers (want 1-%d)", n, maxHeaders)
	}
	seen := make(map[string]bool, len(e.Headers))
	for _, h := range e.Headers {
		if !validHeaderName(h.Name) {
			return errors.New("invalid header name")
		}
		if l := strings.ToLower(h.Name); seen[l] {
			return errors.New("duplicate header name")
		} else {
			seen[l] = true
		}
		if strings.ContainsAny(h.Value, "\r\n\x00") {
			return errors.New("invalid header value")
		}
	}
	if e.Port < 1 || e.Port > 65535 {
		return errors.New("port out of range")
	}
	return validPathPrefix(e.PathPrefix)
}

func validPathPrefix(p string) error {
	if !strings.HasPrefix(p, "/") {
		return errors.New("pathPrefix must start with /")
	}
	if p == "/" {
		return nil
	}
	if strings.HasSuffix(p, "/") {
		return errors.New("pathPrefix must not end with /")
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(`%\;?#`, r) {
			return errors.New("pathPrefix has a forbidden character")
		}
	}
	for _, seg := range strings.Split(p[1:], "/") {
		if seg == "" || seg == "." || seg == ".." {
			return errors.New("pathPrefix has an empty or dot segment")
		}
	}
	return nil
}

// Host names the control plane for the boot log: host and port only, never the
// path, userinfo or token.
func (c *CPCredentials) Host() string {
	u, err := url.Parse(c.endpoint)
	if err != nil {
		return "?"
	}
	return u.Host
}
