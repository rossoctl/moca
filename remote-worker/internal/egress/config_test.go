package egress

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestConfigRequiresAllow(t *testing.T) {
	_, _, err := ConfigFromEnv(envMap(nil))
	if err == nil || !strings.Contains(err.Error(), "MOCA_EGRESS_ALLOW") {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigRefusesMultiTenancy(t *testing.T) {
	_, _, err := ConfigFromEnv(envMap(map[string]string{"MOCA_TENANCY": "multi", "MOCA_EGRESS_ALLOW": "a.example:443"}))
	if err == nil || !strings.Contains(err.Error(), "MI1 S2") {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigRefusesUnknownTenancy(t *testing.T) {
	_, _, err := ConfigFromEnv(envMap(map[string]string{"MOCA_TENANCY": "multiple", "MOCA_EGRESS_ALLOW": "a.example:443"}))
	if err == nil || !strings.Contains(err.Error(), "MOCA_TENANCY") || !strings.Contains(err.Error(), "multiple") {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigDefaults(t *testing.T) {
	cfg, cc, err := ConfigFromEnv(envMap(map[string]string{"MOCA_TENANCY": "single", "MOCA_EGRESS_ALLOW": "a.example:443"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConnsPerVM != 32 || cfg.MaxRequestsPerSession != 10000 {
		t.Fatalf("caps = %d, %d", cfg.MaxConnsPerVM, cfg.MaxRequestsPerSession)
	}
	// The response-header bound defaults to the idle bound, not tighter: the
	// slot is already bounded without it, and a tighter default would 502 an
	// upstream that is legitimately slow to its first header byte.
	if cfg.IdleTimeout != 300*time.Second || cfg.ResponseHeaderTimeout != 300*time.Second {
		t.Fatalf("timeouts = %v, %v", cfg.IdleTimeout, cfg.ResponseHeaderTimeout)
	}
	if cc.Socket != "/run/moca-egress/control.sock" {
		t.Fatalf("socket = %q", cc.Socket)
	}
	if len(cc.AllowedUIDs) != 1 || cc.AllowedUIDs[0] != 0 {
		t.Fatalf("uids = %v", cc.AllowedUIDs)
	}
	if len(cfg.Allow) != 1 || cfg.Resolver == nil || cfg.LocalAddrs == nil || cfg.Audit == nil || cfg.Credentials == nil {
		t.Fatalf("cfg incomplete: %+v", cfg)
	}
}

func TestConfigAllowAll(t *testing.T) {
	cfg, _, err := ConfigFromEnv(envMap(map[string]string{"MOCA_EGRESS_ALLOW": "*"}))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AllowAll || len(cfg.Allow) != 0 {
		t.Fatalf("cfg = %+v", cfg)
	}
	// "*" stays an ordinary-list error everywhere else: mixed, padded, alone
	// beside separators. Only the bare, trimmed sentinel is allow-all.
	for _, v := range []string{"*,a.example", "a.example,*", " * * ", "*,", ",*"} {
		if _, _, err := ConfigFromEnv(envMap(map[string]string{"MOCA_EGRESS_ALLOW": v})); err == nil {
			t.Fatalf("%q: want an error", v)
		}
	}
}

func TestConfigParsesOverrides(t *testing.T) {
	cfg, cc, err := ConfigFromEnv(envMap(map[string]string{
		"MOCA_EGRESS_ALLOW":                    "a.example:443",
		"MOCA_EGRESS_PERMIT_CIDRS":             " 10.0.0.0/8, ,127.0.0.1/32",
		"MOCA_EGRESS_RESOLVER":                 "127.0.0.1:5353",
		"MOCA_EGRESS_MAX_CONNS_PER_VM":         "4",
		"MOCA_EGRESS_MAX_REQUESTS_PER_SESSION": "7",
		"MOCA_EGRESS_CONTROL_SOCK":             "/tmp/x.sock",
		"MOCA_EGRESS_CONTROL_UIDS":             "0, 1000",
		"MOCA_EGRESS_IDLE_TIMEOUT_S":           "45",
		// Whitespace is trimmed, as for every other knob here.
		"MOCA_EGRESS_RESPONSE_HEADER_TIMEOUT_S": " 5 ",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.PermitCIDRs) != 2 || cfg.MaxConnsPerVM != 4 || cfg.MaxRequestsPerSession != 7 {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cfg.IdleTimeout != 45*time.Second || cfg.ResponseHeaderTimeout != 5*time.Second {
		t.Fatalf("timeouts = %v, %v", cfg.IdleTimeout, cfg.ResponseHeaderTimeout)
	}
	if cc.Socket != "/tmp/x.sock" || len(cc.AllowedUIDs) != 2 || cc.AllowedUIDs[1] != 1000 {
		t.Fatalf("cc = %+v", cc)
	}
}

// TestResponseHeaderBoundFollowsARaisedIdleBound pins that the header bound's
// default tracks the idle bound an operator actually set, not the compiled-in
// one. Someone who raises MOCA_EGRESS_IDLE_TIMEOUT_S for a slow upstream would
// otherwise be left with a tighter header bound hiding behind it, which fires
// first and 502s the request the raise was meant to allow.
func TestResponseHeaderBoundFollowsARaisedIdleBound(t *testing.T) {
	cfg, _, err := ConfigFromEnv(envMap(map[string]string{
		"MOCA_EGRESS_ALLOW":          "a.example:443",
		"MOCA_EGRESS_IDLE_TIMEOUT_S": "900",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ResponseHeaderTimeout != 900*time.Second {
		t.Fatalf("response header bound = %v with the idle bound raised to 900s, want 900s",
			cfg.ResponseHeaderTimeout)
	}
}

func TestConfigRejectsBadCIDRAndBadUID(t *testing.T) {
	base := func() map[string]string { return map[string]string{"MOCA_EGRESS_ALLOW": "a.example:443"} }
	cases := map[string]string{
		"MOCA_EGRESS_PERMIT_CIDRS":             "not-a-cidr",
		"MOCA_EGRESS_CONTROL_UIDS":             "-1",
		"MOCA_EGRESS_MAX_CONNS_PER_VM":         "0",
		"MOCA_EGRESS_MAX_REQUESTS_PER_SESSION": "abc",
		"MOCA_EGRESS_RESOLVER":                 "nohostport",
		// A zero is rejected, not read as "no bound": a connection unbounded
		// in time is the #585 defect, not a configuration an operator may pick.
		"MOCA_EGRESS_IDLE_TIMEOUT_S":            "0",
		"MOCA_EGRESS_RESPONSE_HEADER_TIMEOUT_S": "-1",
	}
	for k, v := range cases {
		m := base()
		m[k] = v
		_, _, err := ConfigFromEnv(envMap(m))
		if err == nil || !strings.Contains(err.Error(), k) {
			t.Errorf("%s=%q: err = %v", k, v, err)
		}
		if k == "MOCA_EGRESS_PERMIT_CIDRS" && err != nil && strings.Contains(err.Error(), v) {
			t.Errorf("error leaks permit value: %v", err)
		}
	}
	m := base()
	m["MOCA_EGRESS_CONTROL_UIDS"] = "x"
	if _, _, err := ConfigFromEnv(envMap(m)); err == nil {
		t.Error("non-numeric uid accepted")
	}
}

func credEnv(t *testing.T, extra map[string]string) func(string) string {
	dir := t.TempDir()
	ca := newTestCA(t, true)
	for name, content := range map[string]string{"tok": "secret-token\n", "ca.crt": string(ca.certPEM), "ca.key": string(ca.keyPEM)} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m := map[string]string{
		"MOCA_EGRESS_ALLOW":                  "a.example:443",
		"MOCA_EGRESS_CREDENTIALS_URL":        "https://cp.example",
		"MOCA_EGRESS_CREDENTIALS_TOKEN_FILE": filepath.Join(dir, "tok"),
		"MOCA_EGRESS_CA_CERT_FILE":           filepath.Join(dir, "ca.crt"),
		"MOCA_EGRESS_CA_KEY_FILE":            filepath.Join(dir, "ca.key"),
	}
	for k, v := range extra {
		if v == "" {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	return envMap(m)
}

func TestConfigCredentialsLoaded(t *testing.T) {
	cfg, _, err := ConfigFromEnv(credEnv(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cfg.Credentials.(*CPCredentials); !ok {
		t.Fatalf("credentials = %T", cfg.Credentials)
	}
	if len(cfg.InterceptCACertPEM) == 0 || len(cfg.InterceptCAKeyPEM) == 0 || cfg.interceptor == nil {
		t.Fatal("CA not exposed or interceptor not built")
	}
}

func TestConfigCredentialsDirectoryDefaults(t *testing.T) {
	dir := t.TempDir()
	ca := newTestCA(t, true)
	for name, content := range map[string]string{"egress-token": "tok", "egress-ca.crt": string(ca.certPEM), "egress-ca.key": string(ca.keyPEM)} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	_, _, err := ConfigFromEnv(envMap(map[string]string{
		"MOCA_EGRESS_ALLOW": "a.example:443", "MOCA_EGRESS_CREDENTIALS_URL": "https://cp.example", "CREDENTIALS_DIRECTORY": dir,
	}))
	if err != nil {
		t.Fatal(err)
	}
}

func TestConfigCredentialsFailures(t *testing.T) {
	for _, name := range []string{"MOCA_EGRESS_CREDENTIALS_TOKEN_FILE", "MOCA_EGRESS_CA_CERT_FILE", "MOCA_EGRESS_CA_KEY_FILE"} {
		get := credEnv(t, map[string]string{name: "/nonexistent/file"})
		if _, _, err := ConfigFromEnv(get); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s: err = %v", name, err)
		}
		if _, _, err := ConfigFromEnv(credEnv(t, map[string]string{name: ""})); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s unset: err = %v", name, err)
		}
	}
	if _, _, err := ConfigFromEnv(credEnv(t, map[string]string{"MOCA_EGRESS_CREDENTIALS_TIMEOUT": "soon"})); err == nil ||
		!strings.Contains(err.Error(), "MOCA_EGRESS_CREDENTIALS_TIMEOUT") {
		t.Errorf("timeout: %v", err)
	}
	if _, _, err := ConfigFromEnv(credEnv(t, map[string]string{"MOCA_EGRESS_UPSTREAM_CA": "/nonexistent"})); err == nil ||
		!strings.Contains(err.Error(), "MOCA_EGRESS_UPSTREAM_CA") {
		t.Errorf("upstream: %v", err)
	}
	if _, _, err := ConfigFromEnv(credEnv(t, map[string]string{"MOCA_EGRESS_CREDENTIALS_URL": "http://cp.example"})); err == nil ||
		!strings.Contains(err.Error(), "MOCA_EGRESS_CREDENTIALS_URL") {
		t.Errorf("url: %v", err)
	}
}

func TestConfigBadInterceptCAFailsBoot(t *testing.T) {
	good, other, notCA := newTestCA(t, true), newTestCA(t, true), newTestCA(t, false)
	write := func(b []byte) string {
		p := filepath.Join(t.TempDir(), "f")
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	cases := map[string]map[string]string{
		"garbage cert": {"MOCA_EGRESS_CA_CERT_FILE": write([]byte("junk"))},
		"garbage key":  {"MOCA_EGRESS_CA_KEY_FILE": write([]byte("junk"))},
		"mismatch":     {"MOCA_EGRESS_CA_CERT_FILE": write(good.certPEM), "MOCA_EGRESS_CA_KEY_FILE": write(other.keyPEM)},
		"not a CA":     {"MOCA_EGRESS_CA_CERT_FILE": write(notCA.certPEM), "MOCA_EGRESS_CA_KEY_FILE": write(notCA.keyPEM)},
	}
	for name, extra := range cases {
		_, _, err := ConfigFromEnv(credEnv(t, extra))
		if err == nil || !strings.Contains(err.Error(), "MOCA_EGRESS_CA_") {
			t.Errorf("%s: err = %v", name, err)
			continue
		}
		if strings.Contains(err.Error(), "PRIVATE KEY") {
			t.Errorf("%s: error carries key material", name)
		}
	}
}

func TestConfigHalfConfiguredFails(t *testing.T) {
	for _, name := range []string{"MOCA_EGRESS_CA_KEY_FILE", "MOCA_EGRESS_CA_CERT_FILE", "MOCA_EGRESS_CREDENTIALS_TOKEN_FILE",
		"MOCA_EGRESS_CREDENTIALS_CA", "MOCA_EGRESS_CREDENTIALS_TIMEOUT", "MOCA_EGRESS_UPSTREAM_CA"} {
		_, _, err := ConfigFromEnv(envMap(map[string]string{"MOCA_EGRESS_ALLOW": "a.example:443", name: "x"}))
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestConfigNoCredentialsByDefault(t *testing.T) {
	cfg, _, err := ConfigFromEnv(envMap(map[string]string{"MOCA_EGRESS_ALLOW": "a.example:443"}))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cfg.Credentials.(NoCredentials); !ok {
		t.Fatalf("credentials = %T", cfg.Credentials)
	}
}

func TestConfigNoneTTL(t *testing.T) {
	for v, ok := range map[string]bool{"5": true, "60": true, "300": true, "4": false, "301": false, "0": false, "-1": false, "x": false} {
		_, _, err := ConfigFromEnv(credEnv(t, map[string]string{"MOCA_EGRESS_NONE_TTL_S": v}))
		if (err == nil) != ok {
			t.Errorf("%q: err = %v", v, err)
		} else if err != nil && !strings.Contains(err.Error(), "MOCA_EGRESS_NONE_TTL_S") {
			t.Errorf("%q: error does not name the variable: %v", v, err)
		}
	}
	cfg, _, err := ConfigFromEnv(credEnv(t, map[string]string{"MOCA_EGRESS_NONE_TTL_S": "90"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Credentials.(*CPCredentials).noneTTL; got != 90*time.Second {
		t.Errorf("noneTTL = %v", got)
	}
}
