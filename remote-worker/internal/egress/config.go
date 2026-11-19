package egress

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ControlConfig configures the control socket.
type ControlConfig struct {
	Socket      string
	AllowedUIDs []int
}

const (
	defaultControlSock = "/run/moca-egress/control.sock"
	defaultMaxConns    = 32
	defaultMaxRequests = 10000
	envTenancy         = "MOCA_TENANCY"
	envAllow           = "MOCA_EGRESS_ALLOW"
	envPermit          = "MOCA_EGRESS_PERMIT_CIDRS"
	envResolver        = "MOCA_EGRESS_RESOLVER"
	envMaxConns        = "MOCA_EGRESS_MAX_CONNS_PER_VM"
	envMaxRequests     = "MOCA_EGRESS_MAX_REQUESTS_PER_SESSION"
	envControlSock     = "MOCA_EGRESS_CONTROL_SOCK"
	envControlUIDs     = "MOCA_EGRESS_CONTROL_UIDS"
	envIdleTimeout     = "MOCA_EGRESS_IDLE_TIMEOUT_S"
	envRespHeaderTime  = "MOCA_EGRESS_RESPONSE_HEADER_TIMEOUT_S"
	envCredURL         = "MOCA_EGRESS_CREDENTIALS_URL"
	envCredTokenFile   = "MOCA_EGRESS_CREDENTIALS_TOKEN_FILE"
	envCredCA          = "MOCA_EGRESS_CREDENTIALS_CA"
	envCredTimeout     = "MOCA_EGRESS_CREDENTIALS_TIMEOUT"
	envNoneTTL         = "MOCA_EGRESS_NONE_TTL_S"
	envCACertFile      = "MOCA_EGRESS_CA_CERT_FILE"
	envCAKeyFile       = "MOCA_EGRESS_CA_KEY_FILE"
	envUpstreamCA      = "MOCA_EGRESS_UPSTREAM_CA"
	envCredDir         = "CREDENTIALS_DIRECTORY"
)

// ConfigFromEnv builds the proxy and control configuration from environment
// variables read through get. Every error names its variable; the value of
// MOCA_EGRESS_PERMIT_CIDRS is never echoed.
func ConfigFromEnv(get func(string) string) (Config, ControlConfig, error) {
	var cfg Config
	var cc ControlConfig

	switch t := get(envTenancy); t {
	case "", "single":
	case "multi":
		return cfg, cc, fmt.Errorf("%s=multi: moca-egress is single-tenant only (MI1 S2)", envTenancy)
	default:
		return cfg, cc, fmt.Errorf("%s=%q: want unset or \"single\" (MI1 S2)", envTenancy, t)
	}

	allowRaw := strings.TrimSpace(get(envAllow))
	if allowRaw == "" {
		return cfg, cc, fmt.Errorf("%s is required", envAllow)
	}
	// "*" alone is the allow-everything mode (Config.AllowAll): every
	// destination restriction is off. It is recognised before ParseAllow,
	// which keeps refusing "*" as an ordinary list entry -- "*,example.com"
	// and a list that is only separators remain errors.
	var err error
	if allowRaw == "*" {
		cfg.AllowAll = true
	} else {
		cfg.Allow, err = ParseAllow(allowRaw)
		if err != nil {
			return cfg, cc, fmt.Errorf("%s: %w", envAllow, err)
		}
	}

	for _, item := range strings.Split(get(envPermit), ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		p, err := netip.ParsePrefix(item)
		if err != nil {
			return cfg, cc, fmt.Errorf("%s: an item is not a valid CIDR", envPermit)
		}
		cfg.PermitCIDRs = append(cfg.PermitCIDRs, p)
	}

	if cfg.MaxConnsPerVM, err = positiveInt(get, envMaxConns, defaultMaxConns); err != nil {
		return cfg, cc, err
	}
	if cfg.MaxRequestsPerSession, err = positiveInt(get, envMaxRequests, defaultMaxRequests); err != nil {
		return cfg, cc, err
	}
	// Seconds in, duration out. Both are positive-only: a zero would read as
	// "no bound", and an established connection unbounded in time is the
	// defect these exist to close, not a configuration an operator may pick.
	if cfg.IdleTimeout, err = positiveSeconds(get, envIdleTimeout, defaultIdleTimeout); err != nil {
		return cfg, cc, err
	}
	// The response-header bound defaults to whatever the idle bound came out
	// as, including an operator-raised one, so it never sits tighter than the
	// bound it refines unless an operator asked for that. See the field's doc.
	if cfg.ResponseHeaderTimeout, err = positiveSeconds(get, envRespHeaderTime, cfg.IdleTimeout); err != nil {
		return cfg, cc, err
	}

	cfg.Resolver = net.DefaultResolver
	if hp := strings.TrimSpace(get(envResolver)); hp != "" {
		_, port, err := net.SplitHostPort(hp)
		if err != nil || port == "" {
			return cfg, cc, fmt.Errorf("%s=%q: want host:port", envResolver, hp)
		}
		cfg.Resolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, hp)
		}}
	}
	cfg.LocalAddrs = localAddrs
	if err := credentialsFromEnv(get, &cfg); err != nil {
		return cfg, cc, err
	}
	// Async, because this sink is stdout: a stalled journald must not block the
	// proxy's hot path, nor Unregister and the control socket behind it. The
	// caller flushes it on shutdown via CloseAudit.
	cfg.Audit = NewAsyncSink(NewJSONSink(os.Stdout), 0)

	cc.Socket = get(envControlSock)
	if cc.Socket == "" {
		cc.Socket = defaultControlSock
	}
	if raw := strings.TrimSpace(get(envControlUIDs)); raw == "" {
		cc.AllowedUIDs = []int{0}
	} else {
		for _, item := range strings.Split(raw, ",") {
			item = strings.TrimSpace(item)
			uid, err := strconv.Atoi(item)
			if err != nil || uid < 0 {
				return cfg, cc, fmt.Errorf("%s: %q is not a non-negative integer", envControlUIDs, item)
			}
			cc.AllowedUIDs = append(cc.AllowedUIDs, uid)
		}
	}
	return cfg, cc, nil
}

// credentialsFromEnv wires the control-plane credential client and loads the
// interception CA. With the URL unset, any other credential variable is a
// boot failure: a half-configured host never runs silently without credentials.
func credentialsFromEnv(get func(string) string, cfg *Config) error {
	raw := strings.TrimSpace(get(envCredURL))
	if raw == "" {
		for _, n := range []string{envCredTokenFile, envCredCA, envCredTimeout, envNoneTTL, envCACertFile, envCAKeyFile, envUpstreamCA} {
			if strings.TrimSpace(get(n)) != "" {
				return fmt.Errorf("%s is set but %s is not", n, envCredURL)
			}
		}
		cfg.Credentials = NoCredentials{}
		return nil
	}
	dir := strings.TrimSpace(get(envCredDir))
	// path returns the explicit value, else dir/def when dir is set.
	path := func(name, def string) string {
		if v := strings.TrimSpace(get(name)); v != "" {
			return v
		}
		if dir != "" {
			return filepath.Join(dir, def)
		}
		return ""
	}
	readFile := func(name, p string) ([]byte, error) {
		if p == "" {
			return nil, fmt.Errorf("%s is required when %s is set", name, envCredURL)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("%s: cannot read the file", name)
		}
		if len(bytes.TrimSpace(b)) == 0 {
			return nil, fmt.Errorf("%s: the file is empty", name)
		}
		return b, nil
	}
	tok, err := readFile(envCredTokenFile, path(envCredTokenFile, "egress-token"))
	if err != nil {
		return err
	}
	if cfg.InterceptCACertPEM, err = readFile(envCACertFile, path(envCACertFile, "egress-ca.crt")); err != nil {
		return err
	}
	if cfg.InterceptCAKeyPEM, err = readFile(envCAKeyFile, path(envCAKeyFile, "egress-ca.key")); err != nil {
		return err
	}

	var roots *x509.CertPool // nil = system roots
	caPath := strings.TrimSpace(get(envCredCA))
	if caPath == "" && dir != "" {
		if p := filepath.Join(dir, "egress-api-ca.crt"); fileExists(p) {
			caPath = p
		}
	}
	if caPath != "" {
		pem, err := readFile(envCredCA, caPath)
		if err != nil {
			return err
		}
		roots = x509.NewCertPool()
		if !roots.AppendCertsFromPEM(pem) {
			return fmt.Errorf("%s: no certificate in the file", envCredCA)
		}
	}
	if p := strings.TrimSpace(get(envUpstreamCA)); p != "" {
		pem, err := readFile(envUpstreamCA, p)
		if err != nil {
			return err
		}
		pool, serr := x509.SystemCertPool()
		if serr != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return fmt.Errorf("%s: no certificate in the file", envUpstreamCA)
		}
		cfg.UpstreamRoots = pool
	}

	ca, err := NewLeafCA(cfg.InterceptCACertPEM, cfg.InterceptCAKeyPEM, time.Now)
	if err != nil {
		// The variable names, never key material: err says only what is wrong.
		return fmt.Errorf("%s / %s: %w", envCACertFile, envCAKeyFile, err)
	}
	cfg.interceptor = newInterceptor(ca, cfg.UpstreamRoots)

	timeout := 3 * time.Second
	if v := strings.TrimSpace(get(envCredTimeout)); v != "" {
		if timeout, err = time.ParseDuration(v); err != nil || timeout <= 0 {
			return fmt.Errorf("%s=%q: want a positive Go duration", envCredTimeout, v)
		}
	}
	noneTTL, err := positiveSeconds(get, envNoneTTL, 60*time.Second)
	if err != nil {
		return err
	}
	if noneTTL < minTTL || noneTTL > maxTTL {
		return fmt.Errorf("%s=%q: want 5-300 seconds", envNoneTTL, strings.TrimSpace(get(envNoneTTL)))
	}
	cp, err := NewCPCredentials(CPCredentialsOptions{
		URL: raw, Token: strings.TrimSpace(string(tok)), RootCAs: roots, Timeout: timeout, NoneTTL: noneTTL,
	})
	if err != nil {
		return fmt.Errorf("%s: %w", envCredURL, err)
	}
	cfg.Credentials = cp
	return nil
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func positiveInt(get func(string) string, name string, def int) (int, error) {
	raw := strings.TrimSpace(get(name))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s=%q: want a positive integer", name, raw)
	}
	return n, nil
}

// positiveSeconds reads name as a whole number of seconds, rejecting the same
// values positiveInt does and with the same message.
func positiveSeconds(get func(string) string, name string, def time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(get(name))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s=%q: want a positive integer", name, raw)
	}
	return time.Duration(n) * time.Second, nil
}

// localAddrs lists the host's interface addresses.
func localAddrs() ([]netip.Addr, error) {
	as, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	var out []netip.Addr
	for _, a := range as {
		s := a.String()
		if p, err := netip.ParsePrefix(s); err == nil {
			out = append(out, p.Addr().Unmap())
		} else if ip, err := netip.ParseAddr(s); err == nil {
			out = append(out, ip.Unmap())
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no interface addresses")
	}
	return out, nil
}
