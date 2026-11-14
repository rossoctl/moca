package egress

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRedactPathDropsQueryFragmentUserinfo(t *testing.T) {
	u, _ := url.Parse("http://u:p@h/a%20b?token=s#f")
	if got := RedactPath(u); got != "/a%20b" {
		t.Fatalf("got %q", got)
	}
	u2, _ := url.Parse("http://h")
	if got := RedactPath(u2); got != "/" {
		t.Fatalf("got %q", got)
	}
	for in, want := range map[string]string{
		"http://h/a%3Fb?x=1": "/a%3Fb",
		"http://h/p?":        "/p",
		"mailto:a@b?s=t":     "/",
	} {
		u, err := url.Parse(in)
		if err != nil {
			t.Fatal(err)
		}
		if got := RedactPath(u); got != want {
			t.Errorf("%s: got %q want %q", in, got, want)
		}
	}
	if got := RedactPath(nil); got != "/" {
		t.Fatalf("nil: got %q", got)
	}
}

func TestJSONSinkWritesOneLinePerEvent(t *testing.T) {
	var b bytes.Buffer
	s := NewJSONSink(&b)
	s.Emit(Event{VMID: "vm1", SID: "s1", Host: "a.com", Method: "CONNECT", Status: 200, Decision: DecisionTunnel, Via: "spoof"})
	s.Emit(Event{VMID: "vm1", SID: "s1", Host: "b.com", Method: "GET", Path: "/x", Decision: DecisionForward})
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines=%d: %q", len(lines), b.String())
	}
	for _, l := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("%q: %v", l, err)
		}
		if m["via"] != "moca-egress" {
			t.Fatalf("via=%v", m["via"])
		}
		if m["time"] == "0001-01-01T00:00:00Z" {
			t.Fatal("time not filled")
		}
	}
}

// blockingSink parks every Emit until release is closed, standing in for a
// journald that has stopped reading.
type blockingSink struct {
	release chan struct{}
	mu      sync.Mutex
	seen    []Event
}

func (b *blockingSink) Emit(e Event) {
	<-b.release
	b.mu.Lock()
	b.seen = append(b.seen, e)
	b.mu.Unlock()
}

func (b *blockingSink) events() []Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Event(nil), b.seen...)
}

// countingSink records events without blocking.
type countingSink struct {
	mu   sync.Mutex
	seen []Event
}

func (c *countingSink) Emit(e Event) {
	c.mu.Lock()
	c.seen = append(c.seen, e)
	c.mu.Unlock()
}

func (c *countingSink) events() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Event(nil), c.seen...)
}

func TestAsyncSinkForwardsEveryEventInOrder(t *testing.T) {
	inner := &countingSink{}
	s := NewAsyncSink(inner, 16)
	for i := 0; i < 10; i++ {
		s.Emit(Event{Host: "h", Path: strconv.Itoa(i), Decision: DecisionForward})
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got := inner.events()
	if len(got) != 10 {
		t.Fatalf("forwarded %d events, want 10", len(got))
	}
	for i, e := range got {
		if e.Path != strconv.Itoa(i) {
			t.Fatalf("event %d has path %q: order not preserved", i, e.Path)
		}
		if e.Time.IsZero() {
			t.Fatalf("event %d has no time", i)
		}
	}
}

// TestAsyncSinkEmitDoesNotBlockOnAStalledInnerSink is the assertion for #586's
// second defect: Emit is called under pc.mu and from abort() via Unregister, so
// an Emit that waits on the writer stalls the control socket. Making Emit
// synchronous again must fail here.
func TestAsyncSinkEmitDoesNotBlockOnAStalledInnerSink(t *testing.T) {
	inner := &blockingSink{release: make(chan struct{})}
	s := NewAsyncSink(inner, 4)

	done := make(chan struct{})
	go func() {
		defer close(done)
		// More events than the queue holds: past it they are dropped, never
		// blocked, so every one of these calls must return.
		for i := 0; i < 50; i++ {
			s.Emit(Event{Host: "h", Decision: DecisionTunnel})
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Emit blocked on a stalled sink: the proxy's hot path and Unregister would stall with it")
	}

	close(inner.release)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestAsyncSinkDropsAndReportsTheCountOnClose(t *testing.T) {
	inner := &blockingSink{release: make(chan struct{})}
	s := NewAsyncSink(inner, 2)
	const n = 40
	for i := 0; i < n; i++ {
		s.Emit(Event{Host: "h", Decision: DecisionTunnel})
	}
	close(inner.release)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	var forwarded, dropReports int
	var reported uint64
	for _, e := range inner.events() {
		if e.Decision == DecisionAuditDropped {
			dropReports++
			reported += e.Dropped
			if e.VMID != "" {
				t.Fatalf("audit_dropped names vm %q: drops may span VMs", e.VMID)
			}
			continue
		}
		forwarded++
	}
	if dropReports == 0 {
		t.Fatal("events were dropped but no audit_dropped event was emitted: the gap is silent")
	}
	if forwarded == 0 {
		t.Fatal("nothing was forwarded at all")
	}
	if forwarded+int(reported) != n {
		t.Fatalf("forwarded %d + dropped %d != %d emitted: the count does not account for the gap",
			forwarded, reported, n)
	}
}

func TestAsyncSinkCloseIsIdempotent(t *testing.T) {
	s := NewAsyncSink(&countingSink{}, 4)
	if err := s.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

// TestAsyncSinkEmitAfterCloseDoesNotPanicOrBlock covers the shutdown race: the
// proxy's goroutines may still emit while main is closing the sink.
func TestAsyncSinkEmitAfterCloseDoesNotPanicOrBlock(t *testing.T) {
	s := NewAsyncSink(&countingSink{}, 1)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 10; i++ {
			s.Emit(Event{Host: "h", Decision: DecisionTunnel})
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Emit blocked after Close")
	}
}

func TestAsyncSinkConcurrentEmitAndClose(t *testing.T) {
	inner := &countingSink{}
	s := NewAsyncSink(inner, 8)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Emit(Event{Host: "h", Decision: DecisionTunnel})
		}()
	}
	wg.Wait()
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	var seen int
	for _, e := range inner.events() {
		if e.Decision == DecisionAuditDropped {
			seen += int(e.Dropped)
			continue
		}
		seen++
	}
	if seen != 50 {
		t.Fatalf("accounted for %d of 50 events", seen)
	}
}

// TestCloseAuditIsANoOpOnAPlainSink keeps main's shutdown honest for a sink
// that does not buffer.
func TestCloseAuditIsANoOpOnAPlainSink(t *testing.T) {
	if err := CloseAudit(NewJSONSink(&bytes.Buffer{})); err != nil {
		t.Fatalf("CloseAudit on a jsonSink: %v", err)
	}
	if err := CloseAudit(&countingSink{}); err != nil {
		t.Fatalf("CloseAudit on a non-closer: %v", err)
	}
	s := NewAsyncSink(&countingSink{}, 2)
	if err := CloseAudit(s); err != nil {
		t.Fatalf("CloseAudit on an asyncSink: %v", err)
	}
}

func TestJSONSinkConcurrentEmit(t *testing.T) {
	var b bytes.Buffer
	s := NewJSONSink(&b)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Emit(Event{Host: "h", Decision: DecisionTunnel})
		}()
	}
	wg.Wait()
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 50 {
		t.Fatalf("lines=%d", len(lines))
	}
	for _, l := range lines {
		if !json.Valid([]byte(l)) {
			t.Fatalf("invalid line %q", l)
		}
	}
}

// RedactPath on what the proxy actually parses: request lines, through
// http.ReadRequest, as handler.go and intercept.go see them. The query and
// userinfo never survive; a path segment is kept as it was sent (RedactPath
// does not judge segments), and so is a "#" in an origin-form target, which
// ReadRequest leaves in the path. Both are the guest's own bytes, not a value
// the proxy injected; this test pins that down so a change is deliberate.
func TestRedactPathOnRequestLines(t *testing.T) {
	for line, want := range map[string]string{
		"GET http://u:p@up.example.test/p?token=s3cret HTTP/1.1":        "/p",
		"GET http://up.example.com/p?x=1#frag HTTP/1.1":                 "/p",
		"GET /simple/pkg/?api_key=s3cret HTTP/1.1":                      "/simple/pkg/",
		"GET /dl/tok-0123456789abcdef0123456789abcdef HTTP/1.1":         "/dl/tok-0123456789abcdef0123456789abcdef",
		"GET /p#frag HTTP/1.1":                                          "/p%23frag",
		"POST https://user@up.example.test:8443/a%2Fb?sig=abc HTTP/1.1": "/a%2Fb",
	} {
		r, err := http.ReadRequest(bufio.NewReader(strings.NewReader(line + "\r\nHost: up.example.com\r\n\r\n")))
		if err != nil {
			t.Fatalf("%s: %v", line, err)
		}
		got := RedactPath(r.URL)
		if got != want {
			t.Errorf("%s: got %q want %q", line, got, want)
		}
		for _, secret := range []string{"s3cret", "u:p", "user@", "sig=", "x=1"} {
			if strings.Contains(got, secret) {
				t.Errorf("%s: %q kept %q", line, got, secret)
			}
		}
	}
}

// The Event's JSON names are the wire format the control plane stores
// (packages/control-plane/src/egress-log.ts EVENT_FIELDS), which
// refuses any other field. A field added here must be added there, on purpose.
func TestEventFieldsAreTheWireFormat(t *testing.T) {
	var names []string
	ty := reflect.TypeOf(Event{})
	for i := 0; i < ty.NumField(); i++ {
		names = append(names, strings.Split(ty.Field(i).Tag.Get("json"), ",")[0])
	}
	want := []string{"time", "via", "vm_id", "sid", "sub", "host", "dial_addr", "method", "path",
		"status", "bytes_up", "bytes_down", "credential", "decision", "dropped", "coalesced"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("Event fields %v, want %v", names, want)
	}
}

// A credential is named in Event.Credential; no field carries a value. Every
// string field of a fully populated event, as JSON, holds only what was set.
func TestJSONSinkWritesNoCredentialValue(t *testing.T) {
	var b bytes.Buffer
	NewJSONSink(&b).Emit(Event{VMID: "vm1", SID: "s1", Host: "api.example.com", Method: "GET",
		Path: "/v1/x", Status: 200, Credential: "gh-main", Decision: DecisionCredentialInjected})
	var m map[string]any
	if err := json.Unmarshal(b.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	if m["credential"] != "gh-main" {
		t.Fatalf("credential=%v", m["credential"])
	}
	for k := range m {
		if k == "authorization" || k == "headers" || k == "query" || k == "value" {
			t.Fatalf("an event carries %q", k)
		}
	}
}
