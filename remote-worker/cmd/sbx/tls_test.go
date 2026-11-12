package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
)

// selfIssued returns a CA's PEM and a server certificate for 127.0.0.1 signed by it: the shape of SBX0's exec
// Route when its certificate is self-issued (the token grant's execCa).
func selfIssued(t *testing.T) (caPEM []byte, server tls.Certificate) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test exec CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true,
		KeyUsage: x509.KeyUsageCertSign, BasicConstraintsValid: true}
	caDER, err := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := x509.ParseCertificate(caDER)
	srvKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	srvTpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "127.0.0.1"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	srvDER, err := x509.CreateCertificate(rand.Reader, srvTpl, ca, &srvKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		tls.Certificate{Certificate: [][]byte{srvDER}, PrivateKey: srvKey}
}

type echoExec struct {
	pb.UnimplementedSandboxExecServer
}

func (echoExec) Exec(_ *pb.ExecRequest, s grpc.ServerStreamingServer[pb.ExecEvent]) error {
	if err := s.Send(chunk(pb.Stream_STREAM_STDOUT, "over tls\n")); err != nil {
		return err
	}
	return s.Send(end(0, false))
}

// serveTLS runs a real sandbox/v1 exec server over TLS on loopback and returns its address.
func serveTLS(t *testing.T, cert tls.Certificate) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{Certificates: []tls.Certificate{cert}})))
	pb.RegisterSandboxExecServer(srv, echoExec{})
	go srv.Serve(lis)
	t.Cleanup(srv.Stop)
	return lis.Addr().String()
}

// overTLS dials as the client does (dial: the config's credentials) and runs one command through the client's own
// execOnce, so the test covers the real path end to end.
func overTLS(t *testing.T, c config) (string, error) {
	t.Helper()
	c.sandboxID, c.token, c.timeoutS = "s", "t", 5
	conn, err := dial(c)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := execOnce(ctx, pb.NewSandboxExecClient(conn), c, reqID(), "true", nil)
	return string(r.stdout), err
}

func TestTLSWithTheGrantsCA(t *testing.T) {
	caPEM, cert := selfIssued(t)
	addr := serveTLS(t, cert)
	out, err := overTLS(t, config{addr: addr, tls: true, caPEM: caPEM})
	if err != nil || out != "over tls\n" {
		t.Fatalf("with the extra CA: out %q, err %v", out, err)
	}
}

func TestTLSWithoutTheCAIsRefused(t *testing.T) {
	// the system roots alone do not trust a self-issued certificate: the dial must fail, never fall back
	_, cert := selfIssued(t)
	addr := serveTLS(t, cert)
	if _, err := overTLS(t, config{addr: addr, tls: true}); err == nil {
		t.Fatal("a self-issued certificate was accepted without SBX_CA_FILE")
	}
}

func TestPlaintextCannotTalkToTLS(t *testing.T) {
	_, cert := selfIssued(t)
	addr := serveTLS(t, cert)
	if _, err := overTLS(t, config{addr: addr}); err == nil {
		t.Fatal("a plaintext dial reached a TLS server")
	}
}

func TestTLSConfigFromEnv(t *testing.T) {
	caPEM, _ := selfIssued(t)
	base := map[string]string{"SBX_ADDR": "h:443", "SBX_SANDBOX_ID": "w", "SBX_WORKSPACE_KEY": "k", "SBX_TOKEN": "t"}
	read := func(p string) ([]byte, error) {
		if p == "/ca.pem" {
			return caPEM, nil
		}
		return []byte("not a certificate"), nil
	}
	get := func(extra map[string]string) func(string) string {
		return func(k string) string {
			if v, ok := extra[k]; ok {
				return v
			}
			return base[k]
		}
	}
	c, err := configFrom(get(map[string]string{"SBX_TLS": "1", "SBX_CA_FILE": "/ca.pem"}), read)
	if err != nil || !c.tls || len(c.caPEM) == 0 {
		t.Fatalf("SBX_TLS=1 with a CA: %+v %v", c, err)
	}
	if c, err := configFrom(get(nil), read); err != nil || c.tls {
		t.Fatalf("no SBX_TLS is plaintext, as before: %+v %v", c, err)
	}
	for name, extra := range map[string]map[string]string{
		"a CA without TLS":    {"SBX_CA_FILE": "/ca.pem"},
		"a bad SBX_TLS value": {"SBX_TLS": "yes"},
		"a file with no PEM":  {"SBX_TLS": "1", "SBX_CA_FILE": "/other"},
	} {
		if _, err := configFrom(get(extra), read); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
