package egress

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"sync"
	"time"
)

const (
	maxLeafCache = 1024 // hosts held; the earliest-expiring leaf goes first
	leafLifetime = 24 * time.Hour
	// leafRefreshBefore is how long before expiry a cached leaf stops being
	// handed out, so a connection never starts on a certificate about to lapse.
	leafRefreshBefore = time.Hour
)

// LeafCA mints and caches the per-host leaf certificates the interceptor
// presents to a guest. The CA key never leaves this struct.
type LeafCA struct {
	cert *x509.Certificate
	key  crypto.Signer
	now  func() time.Time

	mu    sync.Mutex
	cache map[string]*leafEntry
}

type leafEntry struct {
	cert      *tls.Certificate
	notAfter  time.Time
	refreshAt time.Time // when the entry stops being handed out
}

// NewLeafCA parses a CA certificate and its private key. It refuses a
// certificate that is not a CA and a key that does not belong to it. Errors
// never carry key material.
func NewLeafCA(certPEM, keyPEM []byte, now func() time.Time) (*LeafCA, error) {
	if now == nil {
		now = time.Now
	}
	blk, _ := pem.Decode(certPEM)
	if blk == nil || blk.Type != "CERTIFICATE" {
		return nil, errors.New("no CERTIFICATE block")
	}
	cert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return nil, errors.New("cannot parse the certificate")
	}
	if !cert.IsCA || !cert.BasicConstraintsValid {
		return nil, errors.New("the certificate is not a CA (basic constraints CA:TRUE is required)")
	}
	if cert.KeyUsage != 0 && cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, errors.New("the CA certificate may not sign certificates (keyCertSign is missing)")
	}
	if n := now(); n.Before(cert.NotBefore) {
		return nil, errors.New("the CA certificate is not yet valid")
	} else if !n.Before(cert.NotAfter) {
		return nil, errors.New("the CA certificate has expired")
	}
	key, err := parseSigner(keyPEM)
	if err != nil {
		return nil, err
	}
	type eq interface{ Equal(crypto.PublicKey) bool }
	pub, ok := key.Public().(eq)
	if !ok || !pub.Equal(cert.PublicKey) {
		return nil, errors.New("the private key does not match the certificate")
	}
	return &LeafCA{cert: cert, key: key, now: now, cache: map[string]*leafEntry{}}, nil
}

func parseSigner(keyPEM []byte) (crypto.Signer, error) {
	blk, _ := pem.Decode(keyPEM)
	if blk == nil {
		return nil, errors.New("no PEM block in the key")
	}
	if k, err := x509.ParsePKCS8PrivateKey(blk.Bytes); err == nil {
		if s, ok := k.(crypto.Signer); ok {
			return s, nil
		}
	}
	if k, err := x509.ParseECPrivateKey(blk.Bytes); err == nil {
		return k, nil
	}
	if k, err := x509.ParsePKCS1PrivateKey(blk.Bytes); err == nil {
		return k, nil
	}
	return nil, errors.New("cannot parse the private key (want PKCS#8, SEC1 or PKCS#1)")
}

// Leaf returns a certificate for host, valid 24 h and cached until an hour
// before it expires. host is a normalised DNS name or an IP literal.
func (ca *LeafCA) Leaf(host string) (*tls.Certificate, error) {
	ca.mu.Lock()
	defer ca.mu.Unlock()
	now := ca.now()
	if e, ok := ca.cache[host]; ok && now.Before(e.refreshAt) {
		return e.cert, nil
	}
	if !now.Before(ca.cert.NotAfter) {
		return nil, errors.New("egress: the interception CA has expired")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	notAfter := now.Add(leafLifetime)
	refreshAt := notAfter.Add(-leafRefreshBefore)
	if notAfter.After(ca.cert.NotAfter) {
		// Never outlive the CA; a leaf capped here is good until then.
		notAfter, refreshAt = ca.cert.NotAfter, ca.cert.NotAfter
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: host},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		return nil, errors.New("cannot sign a leaf certificate")
	}
	c := &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	if _, ok := ca.cache[host]; !ok && len(ca.cache) >= maxLeafCache {
		var oldest string
		var oldestAt time.Time
		first := true
		for h, e := range ca.cache {
			if first || e.notAfter.Before(oldestAt) {
				oldest, oldestAt, first = h, e.notAfter, false
			}
		}
		delete(ca.cache, oldest)
	}
	ca.cache[host] = &leafEntry{cert: c, notAfter: notAfter, refreshAt: refreshAt}
	return c, nil
}
