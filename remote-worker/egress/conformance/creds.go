//go:build unix

package conformance

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// This file holds the fixtures of the interception cases (SBX0.2b spec
// section 10.2): a fake control plane that speaks the lookup wire, test CAs,
// a TLS upstream, and a guest that speaks TLS through a CONNECT. Nothing here
// imports the implementation: the binary under test sees only files, env
// variables and sockets.

// testCA is a throwaway certificate authority.
type testCA struct {
	cert    *x509.Certificate
	key     *ecdsa.PrivateKey
	certPEM []byte
	keyPEM  []byte
	pool    *x509.CertPool
}

func newTestCA(name string) (*testCA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	kd, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return &testCA{
		cert: cert, key: key, pool: pool,
		certPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		keyPEM:  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd}),
	}, nil
}

// issue signs a server certificate for name (a DNS name) and 127.0.0.1.
func (ca *testCA) issue(name string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: name},
		DNSNames:     []string{name},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// ---- the fake control plane ----

// credHeader and credElem are one element of the lookup's 200 body.
type credHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type credElem struct {
	Name       string       `json:"name"`
	Port       int          `json:"port"`
	PathPrefix string       `json:"pathPrefix"`
	Headers    []credHeader `json:"headers"`
	ExpiresAt  *string      `json:"expiresAt"`
}

// cpAnswer is what the fake says for one (sandbox, host).
type cpAnswer struct {
	elems     []credElem // 200 when the owner has any
	subject   string
	ttl       int
	status    int // when non-zero, this status with an empty body
	failFirst int // answer 500 to this many first calls
}

type cpKey struct{ sid, host string }

// fakeCP is the fake control plane: POST /v1/egress/credential with a bearer.
// An unset (sandbox, host) is the owner having none (404 no_credential).
type fakeCP struct {
	srv   *httptest.Server
	token string

	mu      sync.Mutex
	answers map[cpKey]cpAnswer
	lookups map[cpKey]int
	badAuth int
	delay   time.Duration
}

func newFakeCP() *fakeCP {
	f := &fakeCP{token: "egress-token-" + fmt.Sprint(time.Now().UnixNano()),
		answers: map[cpKey]cpAnswer{}, lookups: map[cpKey]int{}}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.serve))
	return f
}

func (f *fakeCP) set(sid, host string, a cpAnswer) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers[cpKey{sid, host}] = a
}

func (f *fakeCP) setDelay(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.delay = d
}

// count is how many lookups the fake has answered for (sid, host).
func (f *fakeCP) count(sid, host string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lookups[cpKey{sid, host}]
}

func (f *fakeCP) Close() error { f.srv.Close(); return nil }

func (f *fakeCP) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/v1/egress/credential" {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		f.mu.Lock()
		f.badAuth++
		f.mu.Unlock()
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var req struct{ Sandbox, Host string }
	if json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req) != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	k := cpKey{req.Sandbox, req.Host}
	f.mu.Lock()
	f.lookups[k]++
	n := f.lookups[k]
	a, ok := f.answers[k]
	d := f.delay
	f.mu.Unlock()
	if d > 0 {
		time.Sleep(d)
	}
	w.Header().Set("Content-Type", "application/json")
	switch {
	case n <= a.failFirst:
		w.WriteHeader(http.StatusInternalServerError)
	case a.status != 0:
		w.WriteHeader(a.status)
	case !ok || len(a.elems) == 0:
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"no_credential"}`)
	default:
		ttl := a.ttl
		if ttl == 0 {
			ttl = 60
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"subject": a.subject, "ttlSeconds": ttl, "credentials": a.elems})
	}
}

// cred builds an element; hdrs are "Name: value" lines. Port 0 is filled in
// with the upstream's port by icWorld.give.
func cred(name, prefix string, hdrs ...string) credElem {
	e := credElem{Name: name, PathPrefix: prefix}
	for _, h := range hdrs {
		n, v, _ := strings.Cut(h, ": ")
		e.Headers = append(e.Headers, credHeader{n, v})
	}
	return e
}

// ---- the world of an interception case ----

// icWorld is a case's fixtures: the fake control plane, the interception CA
// (the guest's trust anchor for an intercepted host), the upstream CA (which
// signs the upstream and is handed to the binary as MOCA_EGRESS_UPSTREAM_CA)
// and a TLS upstream named up.test.
type icWorld struct {
	cp   *fakeCP
	icCA *testCA
	upCA *testCA
	up   *httpUpstream
	hp   string // up.test:<port>
}

// enableCredentials turns credential mode on in h's env: token, control-plane
// CA, interception CA and upstream CA all go to files under h's directory.
func (h *harness) enableCredentials() (*icWorld, error) {
	w := &icWorld{cp: newFakeCP()}
	h.ups = append(h.ups, w.cp)
	var err error
	if w.icCA, err = newTestCA("conformance interception CA"); err != nil {
		return nil, err
	}
	if w.upCA, err = newTestCA("conformance upstream CA"); err != nil {
		return nil, err
	}
	cpPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: w.cp.srv.Certificate().Raw})
	files := map[string][]byte{
		"token":        []byte(w.cp.token + "\n"),
		"cp-ca.pem":    cpPEM,
		"ica.crt":      w.icCA.certPEM,
		"ica.key":      w.icCA.keyPEM,
		"upstream.pem": w.upCA.certPEM,
	}
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(h.dir, name), b, 0o600); err != nil {
			return nil, err
		}
	}
	p := func(n string) string { return filepath.Join(h.dir, n) }
	h.env[EnvCredentialsURL] = w.cp.srv.URL
	h.env[EnvCredentialsTokenFile] = p("token")
	h.env[EnvCredentialsCA] = p("cp-ca.pem")
	h.env[EnvCACertFile] = p("ica.crt")
	h.env[EnvCAKeyFile] = p("ica.key")
	h.env[EnvUpstreamCA] = p("upstream.pem")
	return w, nil
}

// interceptWorld is enableCredentials plus a TLS upstream signed by the
// upstream CA, allowed and permitted as up.test.
func (h *harness) interceptWorld() (*icWorld, error) {
	w, err := h.enableCredentials()
	if err != nil {
		return nil, err
	}
	if err := w.startUpstream(h, w.upCA); err != nil {
		return nil, err
	}
	return w, nil
}

// startUpstream starts the TLS upstream with a certificate from signer.
func (w *icWorld) startUpstream(h *harness, signer *testCA) error {
	var err error
	if w.up, err = h.httpsUp(signer); err != nil {
		return err
	}
	w.hp = fmt.Sprintf("%s:%d", upName, w.up.port())
	return h.loopbackUpstreams(w.up.port())
}

// give sets what the owner of sid holds for up.test.
func (w *icWorld) give(sid string, ttl int, els ...credElem) {
	out := make([]credElem, len(els))
	for i, e := range els {
		if e.Port == 0 {
			e.Port = w.up.port()
		}
		out[i] = e
	}
	w.cp.set(sid, upName, cpAnswer{elems: out, subject: "user-" + sid, ttl: ttl})
}

// httpsUp is httpUp over TLS, with a certificate for up.test from signer.
func (h *harness) httpsUp(signer *testCA) (*httpUpstream, error) {
	cert, err := signer.issue(upName)
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	u := &httpUpstream{ln: ln, slowArrived: make(chan struct{}, 16)}
	u.srv = &http.Server{Handler: http.HandlerFunc(u.serveHTTP), ReadHeaderTimeout: ioWait,
		ErrorLog:     log.New(io.Discard, "", 0),
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){}}
	tl := tls.NewListener(countingListener{ln, u}, &tls.Config{
		Certificates: []tls.Certificate{cert}, NextProtos: []string{"http/1.1"}, MinVersion: tls.VersionTLS12})
	go func() { _ = u.srv.Serve(tl) }()
	h.ups = append(h.ups, u.srv)
	return u, nil
}

// ---- the guest over TLS ----

// connConn is a conn whose reads come from r.
type connConn struct {
	net.Conn
	r io.Reader
}

func (c connConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// tlsGuest dials v, sends CONNECT hostport and, on the exact 200, handshakes
// TLS with cfg. The returned guest speaks HTTP/1.1 inside the tunnel.
func (h *harness) tlsGuest(v vm, hostport string, cfg *tls.Config) (*guest, error) {
	g, err := h.dial(v)
	if err != nil {
		return nil, err
	}
	r, err := g.connect(hostport)
	if err != nil {
		g.close()
		return nil, err
	}
	if r.status != 200 {
		g.close()
		return nil, fmt.Errorf("CONNECT %s: status %d %q", hostport, r.status, r.body)
	}
	tc := tls.Client(connConn{g.c, g.br}, cfg)
	if err := tc.Handshake(); err != nil {
		g.close()
		return nil, fmt.Errorf("TLS handshake through the tunnel: %w", err)
	}
	return &guest{c: tc, br: bufio.NewReader(tc)}, nil
}

// trusting is a client config that trusts only pool, for up.test.
func trusting(pool *x509.CertPool) *tls.Config {
	return &tls.Config{RootCAs: pool, ServerName: upName, MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}}
}

// req writes one request with the exact request-target and host, and reads
// one response.
func (g *guest) req(method, target, host string, extra ...string) (response, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s HTTP/1.1\r\nHost: %s\r\n", method, target, host)
	for _, e := range extra {
		b.WriteString(e + "\r\n")
	}
	b.WriteString("\r\n")
	return g.do(method, b.String())
}

// headerValues returns every value of name the upstream saw, across requests.
func (rq seenRequest) values(name string) []string { return rq.header.Values(name) }
