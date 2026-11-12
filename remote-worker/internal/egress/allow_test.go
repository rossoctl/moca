package egress

import (
	"os"
	"strings"
	"testing"
)

func TestAllowMatchNormalises(t *testing.T) {
	cases := []struct {
		name    string
		allow   string
		host    string
		port    uint16
		connect bool
		want    bool
	}{
		{"mixed case", "api.github.com", "API.GitHub.com", 443, true, true},
		{"trailing dot", "api.github.com", "api.github.com.", 443, true, true},
		{"entry mixed case", "API.GitHub.com", "api.github.com", 443, true, true},
		{"wildcard sub", "*.githubusercontent.com", "objects.githubusercontent.com", 443, true, true},
		{"wildcard apex", "*.githubusercontent.com", "githubusercontent.com", 443, true, false},
		{"wildcard deep", "*.githubusercontent.com", "a.b.githubusercontent.com", 443, true, true},
		{"wildcard lookalike", "*.githubusercontent.com", "evilgithubusercontent.com", 443, true, false},
		{"default connect 443", "example.com", "example.com", 443, true, true},
		{"default connect 80 no", "example.com", "example.com", 80, true, false},
		{"default plain 80", "example.com", "example.com", 80, false, true},
		{"default plain 443 no", "example.com", "example.com", 443, false, false},
		{"explicit port", "example.com:8443", "example.com", 8443, true, true},
		{"explicit port other", "example.com:8443", "example.com", 443, true, false},
		{"explicit port plain", "example.com:8443", "example.com", 8443, false, true},
		{"ipv6 bracketed", "[::1]", "::1", 443, true, true},
		{"ipv6 bracketed query", "[::1]", "[::1]", 443, true, true},
		{"ipv6 port", "[::1]:8080", "::1", 8080, false, true},
		{"other host", "example.com", "other.com", 443, true, false},
		{"bad host", "example.com", "exa mple.com", 443, true, false},
		{"empty host", "example.com", "", 443, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e, err := ParseAllow(c.allow)
			if err != nil {
				t.Fatal(err)
			}
			if got := Allowed(e, c.host, c.port, c.connect); got != c.want {
				t.Fatalf("Allowed(%q,%q,%d,%v)=%v want %v", c.allow, c.host, c.port, c.connect, got, c.want)
			}
		})
	}
}

func TestParseAllowEntries(t *testing.T) {
	e, err := ParseAllow(" A.com ,, *.B.com:8443 ,[::1]:80,1.2.3.4")
	if err != nil {
		t.Fatal(err)
	}
	want := []AllowEntry{
		{Host: "a.com"},
		{Host: "b.com", Wildcard: true, Port: 8443},
		{Host: "::1", Port: 80},
		{Host: "1.2.3.4"},
	}
	if len(e) != len(want) {
		t.Fatalf("got %+v", e)
	}
	for i := range want {
		if e[i] != want[i] {
			t.Fatalf("entry %d: got %+v want %+v", i, e[i], want[i])
		}
	}
}

func TestParseAllowRefusesWildcardsThatMeanEverything(t *testing.T) {
	for _, s := range []string{
		"", " ", ",,", "*", "*.", "*.10.0.0.1", "*.[::1]", "*.::1",
		"https://example.com", "example.com/path", "example.com:0",
		"example.com:65536", "example.com:x", ":443", "user@example.com",
	} {
		if e, err := ParseAllow(s); err == nil {
			t.Errorf("ParseAllow(%q) = %+v, want error", s, e)
		}
	}
}

func TestNormalizeHost(t *testing.T) {
	ok := map[string]string{"EXAMPLE.com": "example.com", "a.b.": "a.b", "[::1]": "::1", "[FE80::1]": "fe80::1"}
	for in, want := range ok {
		got, err := NormalizeHost(in)
		if err != nil || got != want {
			t.Errorf("NormalizeHost(%q)=%q,%v want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", ".", "a b", "a/b", "a@b", "a\tb"} {
		if got, err := NormalizeHost(in); err == nil {
			t.Errorf("NormalizeHost(%q)=%q, want error", in, got)
		}
	}
}

func TestNormalizeHostHygiene(t *testing.T) {
	for _, in := range []string{"K.example", "k\u212a.example", "a\x00b", "a\x7fb", "a\\b", "a%2eb", "a?b", "a#b", "a*b", "bücher.example"} {
		if got, err := NormalizeHost(in); err == nil {
			t.Errorf("NormalizeHost(%q)=%q, want error", in, got)
		}
	}
	if got, err := NormalizeHost("XN--BCHER-KVA.example"); err != nil || got != "xn--bcher-kva.example" {
		t.Errorf("punycode: %q %v", got, err)
	}
	if e, err := ParseAllow("*.xn--bcher-kva.example"); err != nil || !e[0].Wildcard {
		t.Errorf("wildcard punycode: %+v %v", e, err)
	}
}

// deploy/sbx/egress-allow.env is the default allowlist install-host.sh seeds a host's
// moca-egress.env from; a bad entry would surface only when moca-egress fails to boot on
// a host, so it is pinned here instead.
func TestDefaultAllowlistFile(t *testing.T) {
	b, err := os.ReadFile("../../../deploy/sbx/egress-allow.env")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// Match install-host.sh exactly: sed -n 's/^MOCA_EGRESS_ALLOW=//p' -- the key at
	// column 0, no trimming -- so an indented line or a CRLF file fails here the same
	// way it mis-seeds (or falls back) on a host.
	var line string
	for _, l := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(l, "MOCA_EGRESS_ALLOW="); ok {
			line = v
		}
	}
	if line == "" {
		t.Fatal("no MOCA_EGRESS_ALLOW line in deploy/sbx/egress-allow.env")
	}
	entries, err := ParseAllow(line)
	if err != nil {
		t.Fatalf("ParseAllow: %v", err)
	}
	if len(entries) < 10 {
		t.Fatalf("got %d entries, want the full default list", len(entries))
	}
	if !Allowed(entries, "registry.npmjs.org", 443, true) {
		t.Error("registry.npmjs.org:443 not allowed")
	}
	if Allowed(entries, "example.org", 443, true) {
		t.Error("example.org allowed")
	}
}
