package egress

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"
)

// cached reports how many hosts have a leaf in the cache.
func (ca *LeafCA) cached() int {
	ca.mu.Lock()
	defer ca.mu.Unlock()
	return len(ca.cache)
}

// testCA is a throwaway CA for tests.
type testCA struct {
	cert    *x509.Certificate
	key     *ecdsa.PrivateKey
	certPEM []byte
	keyPEM  []byte
}

func newTestCA(t *testing.T, isCA bool) testCA {
	t.Helper()
	return newTestCAWindow(t, isCA, time.Now().Add(-time.Hour), time.Now().Add(48*time.Hour))
}

func newTestCAWindow(t *testing.T, isCA bool, notBefore, notAfter time.Time) testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test ca"},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  isCA,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	kd, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return testCA{cert: cert, key: key,
		certPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		keyPEM:  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd})}
}

func (c testCA) pool() *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(c.cert)
	return p
}

// issue signs a server certificate for the names.
func (c testCA) issue(t *testing.T, dns []string, ips []net.IP) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     dns,
		IPAddresses:  ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, &key.PublicKey, c.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func TestLeafVerifiesAgainstCAAndIsCached(t *testing.T) {
	ca := newTestCA(t, true)
	now := time.Now()
	clock := func() time.Time { return now }
	l, err := NewLeafCA(ca.certPEM, ca.keyPEM, clock)
	if err != nil {
		t.Fatal(err)
	}
	c1, err := l.Leaf("api.example.com")
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(c1.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{DNSName: "api.example.com", Roots: ca.pool(), CurrentTime: now}); err != nil {
		t.Fatalf("leaf does not verify: %v", err)
	}
	if len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != "api.example.com" {
		t.Fatalf("DNSNames %v", leaf.DNSNames)
	}
	if k, ok := leaf.PublicKey.(*ecdsa.PublicKey); !ok || k.Curve != elliptic.P256() {
		t.Fatalf("leaf key %T", leaf.PublicKey)
	}
	if d := leaf.NotAfter.Sub(now); d < 23*time.Hour+59*time.Minute || d > 24*time.Hour+time.Minute {
		t.Fatalf("NotAfter is %v from now", d)
	}
	c2, _ := l.Leaf("api.example.com")
	if c1 != c2 {
		t.Fatal("second call did not return the cached leaf")
	}
	now = now.Add(22 * time.Hour)
	if c3, _ := l.Leaf("api.example.com"); c3 != c1 {
		t.Fatal("leaf reminted before the last hour")
	}
	now = now.Add(time.Hour) // 23h
	c4, err := l.Leaf("api.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if c4 == c1 {
		t.Fatal("leaf not reminted at 23h")
	}
}

func TestLeafForAnIPLiteral(t *testing.T) {
	ca := newTestCA(t, true)
	l, err := NewLeafCA(ca.certPEM, ca.keyPEM, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	c, err := l.Leaf("203.0.113.7")
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(c.Certificate[0])
	if _, err := leaf.Verify(x509.VerifyOptions{DNSName: "203.0.113.7", Roots: ca.pool()}); err != nil {
		t.Fatalf("ip leaf does not verify: %v", err)
	}
}

func TestNewLeafCARefusesBadInput(t *testing.T) {
	good := newTestCA(t, true)
	other := newTestCA(t, true)
	notCA := newTestCA(t, false)
	for name, c := range map[string]struct{ cert, key []byte }{
		"garbage cert": {[]byte("nope"), good.keyPEM},
		"garbage key":  {good.certPEM, []byte("nope")},
		"mismatch":     {good.certPEM, other.keyPEM},
		"not a CA":     {notCA.certPEM, notCA.keyPEM},
	} {
		_, err := NewLeafCA(c.cert, c.key, time.Now)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		if strings.Contains(err.Error(), "PRIVATE KEY") || strings.Contains(err.Error(), string(good.keyPEM)) {
			t.Errorf("%s: error carries key material: %v", name, err)
		}
	}
}

func TestNewLeafCARefusesOutOfWindowCA(t *testing.T) {
	now := time.Now()
	expired := newTestCAWindow(t, true, now.Add(-48*time.Hour), now.Add(-time.Hour))
	future := newTestCAWindow(t, true, now.Add(time.Hour), now.Add(48*time.Hour))
	for name, c := range map[string]testCA{"expired": expired, "not yet valid": future} {
		_, err := NewLeafCA(c.certPEM, c.keyPEM, time.Now)
		if err == nil {
			t.Errorf("%s CA accepted", name)
		} else if strings.Contains(err.Error(), "PRIVATE KEY") {
			t.Errorf("%s: error carries key material", name)
		}
	}
}

func TestLeafNotAfterCappedAtCA(t *testing.T) {
	now := time.Now()
	ca := newTestCAWindow(t, true, now.Add(-time.Hour), now.Add(3*time.Hour))
	l, err := NewLeafCA(ca.certPEM, ca.keyPEM, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	c, err := l.Leaf("a.example")
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(c.Certificate[0])
	if !leaf.NotAfter.Equal(ca.cert.NotAfter) {
		t.Fatalf("leaf NotAfter %v, CA %v", leaf.NotAfter, ca.cert.NotAfter)
	}
}

func TestLeafRefusedOnceCAExpires(t *testing.T) {
	now := time.Now()
	ca := newTestCAWindow(t, true, now.Add(-time.Hour), now.Add(2*time.Hour))
	cur := now
	l, err := NewLeafCA(ca.certPEM, ca.keyPEM, func() time.Time { return cur })
	if err != nil {
		t.Fatal(err)
	}
	cur = now.Add(3 * time.Hour)
	if _, err := l.Leaf("a.example"); err == nil {
		t.Fatal("minted past CA expiry")
	}
}

func TestLeafCacheBounded(t *testing.T) {
	ca := newTestCA(t, true)
	l, err := NewLeafCA(ca.certPEM, ca.keyPEM, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxLeafCache+20; i++ {
		if _, err := l.Leaf(fmt.Sprintf("h%d.example", i)); err != nil {
			t.Fatal(err)
		}
	}
	if n := l.cached(); n > maxLeafCache {
		t.Fatalf("cache = %d", n)
	}
}
