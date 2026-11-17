//go:build unix

package conformance

import (
	"strings"
	"testing"
)

const fixtureToken = "Bearer s3cr3t-fixture-token"

// A failing case must not print a credential value.
func TestFailureMessagesCarryNoCredential(t *testing.T) {
	u := &httpUpstream{reqs: []seenRequest{{path: "/x", header: map[string][]string{
		"Authorization": {fixtureToken}, "X-Api-Key": {fixtureToken}}}}}
	var msgs []string
	for _, e := range []error{
		wantAuth(u, "/x", "Bearer other"), wantAuth(u, "/x", ""),
		wantHeader(u, "/x", "X-Api-Key", "Bearer other"),
	} {
		if e == nil {
			t.Fatal("expected a failure")
		}
		msgs = append(msgs, e.Error())
	}
	h := &harness{seen: []map[string]any{
		{"decision": "x", "authorization": fixtureToken, "note": "has " + fixtureToken, "value": "s3cr3t-fixture-token"},
	}}
	msgs = append(msgs, h.seenText())
	for _, m := range msgs {
		if strings.Contains(m, "s3cr3t") {
			t.Errorf("credential in output: %s", m)
		}
	}
}

// The redaction reaches into nested objects and arrays: an implementation is
// free to emit structured fields (a header map, a list of attempts), and a
// credential inside one must not print either.
func TestRedactEventIsDeep(t *testing.T) {
	h := &harness{seen: []map[string]any{{
		"decision": "x",
		"headers":  map[string]any{"Authorization": "s3cr3t-fixture-token", "Accept": "text/plain"},
		"attempts": []any{
			map[string]any{"value": "s3cr3t-fixture-token"},
			"note " + fixtureToken,
			[]any{map[string]any{"token": "s3cr3t-fixture-token"}},
		},
	}}}
	txt := h.seenText()
	if n := strings.Count(txt, "s3cr3t"); n != 0 {
		t.Errorf("the fixture credential is in the output %d times", n) // the text itself is not printed
	}
	if !strings.Contains(txt, "text/plain") {
		t.Error("a non-secret nested value was redacted too")
	}
}
