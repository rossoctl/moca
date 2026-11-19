//go:build unix

package conformance

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
)

// Each case is pinned: it was run against moca-egress with the named rule
// broken and observed to FAIL. The "pinned against" comment names the
// mutation.

// identityFromConnection: the caller is decided by the listener a connection
// arrives on. Two VMs of two sessions each open a tunnel; each audit event
// names the VM and session its socket was registered with, and no other.
//
// pinned against: binding every accepted conn to one fixed caller in
// Proxy.serve instead of the VM binding's caller.
func identityFromConnection(ctx context.Context, t Target) error {
	var echo *echoUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		return h.loopbackUpstreams(echo.port())
	}, func(h *harness) error {
		a, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		b, err := h.register("vm-b", "sid-b")
		if err != nil {
			return err
		}
		hp := net.JoinHostPort(upName, strconv.Itoa(echo.port()))
		for _, v := range []vm{a, b} {
			g, err := h.dial(v)
			if err != nil {
				return err
			}
			r, err := g.connect(hp)
			if err == nil && r.status != 200 {
				err = fmt.Errorf("CONNECT on %s: status %d %q", v.id, r.status, r.body)
			}
			if err == nil {
				err = g.echoThrough([]byte("hello from " + v.id))
			}
			g.close()
			if err != nil {
				return err
			}
			if _, err := h.wait(event{"decision": "tunnel", "vm_id": v.id, "sid": v.sid}); err != nil {
				return err
			}
		}
		if err := h.settle(); err != nil {
			return err
		}
		for _, m := range h.seen {
			vmID, sid := m["vm_id"], m["sid"]
			if (vmID == "vm-a" && sid != "sid-a") || (vmID == "vm-b" && sid != "sid-b") ||
				(vmID != "vm-a" && vmID != "vm-b") {
				return fmt.Errorf("event with vm_id %v sid %v: identity not from the connection: %v", vmID, sid, m)
			}
		}
		return nil
	})
}

// forgedSessionHeaderIgnored: a request on vm-b's socket that names vm-a's
// session, VM and subject in X-Moca-* headers and carries a
// Proxy-Authorization is still vm-b's, and none of those headers reaches the
// upstream. vm-a's session is capped at one request and has used it, so a
// forged header that moved the request to vm-a's session would also be
// refused with 429.
//
// pinned against: letting an X-Moca-Session request header override the
// caller's session in proxyConn.handle.
func forgedSessionHeaderIgnored(ctx context.Context, t Target) error {
	var up *httpUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if up, err = h.httpUp(); err != nil {
			return err
		}
		h.env[EnvMaxRequests] = "1"
		return h.loopbackUpstreams(up.port())
	}, func(h *harness) error {
		a, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		b, err := h.register("vm-b", "sid-b")
		if err != nil {
			return err
		}
		ga, err := h.dial(a)
		if err != nil {
			return err
		}
		defer ga.close()
		if r, err := ga.get(upURL(up.port(), "/a")); err != nil || r.status != 200 {
			return fmt.Errorf("vm-a's own request: %v %v", r.status, err)
		}
		gb, err := h.dial(b)
		if err != nil {
			return err
		}
		defer gb.close()
		r, err := gb.get(upURL(up.port(), "/b"),
			"X-Moca-Session: sid-a", "X-Moca-Sid: sid-a", "X-Moca-Vm-Id: vm-a", "X-Moca-Sub: alice",
			"Proxy-Authorization: forged")
		if err != nil {
			return err
		}
		if r.status != 200 {
			return fmt.Errorf("vm-b's request with forged headers: status %d %q, want 200", r.status, r.body)
		}
		if _, err := h.wait(event{"decision": "forward", "path": "/b", "vm_id": "vm-b", "sid": "sid-b"}); err != nil {
			return err
		}
		if err := h.settle(); err != nil {
			return err
		}
		for _, m := range h.seen {
			if m["path"] == "/b" && (m["vm_id"] != "vm-b" || m["sid"] != "sid-b" || !noSubject(m)) {
				return fmt.Errorf("forged headers changed the caller: %v", m)
			}
		}
		for _, rq := range up.requests() {
			if rq.path != "/b" {
				continue
			}
			for k := range rq.header {
				lk := strings.ToLower(k)
				if strings.HasPrefix(lk, "x-moca-") || lk == "proxy-authorization" {
					return fmt.Errorf("upstream received %s", k)
				}
			}
		}
		return nil
	})
}

// offAllowlistNamed403: a destination off the allowlist is refused by name,
// for CONNECT and for plain HTTP, before it is resolved and before any dial.
// The name resolves to the permitted fake upstream, so only the allowlist
// stands in the way.
//
// pinned against: Allowed returning true for every host.
func offAllowlistNamed403(ctx context.Context, t Target) error {
	var echo *echoUpstream
	const off = "off.test"
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		if err := h.dns.answer(off, "127.0.0.1"); err != nil {
			return err
		}
		return h.loopbackUpstreams(echo.port())
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		hp := net.JoinHostPort(off, strconv.Itoa(echo.port()))
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		r, err := g.connect(hp)
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_denied", off); err != nil {
			return fmt.Errorf("CONNECT %s: %w", hp, err)
		}
		g, err = h.dial(v)
		if err != nil {
			return err
		}
		r, err = g.get("http://" + hp + "/x")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_denied", off); err != nil {
			return fmt.Errorf("GET http://%s/x: %w", hp, err)
		}
		if _, err := h.wait(event{"decision": "destination_denied", "host": off, "method": "CONNECT", "status": 403, "vm_id": "vm-a"}); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "destination_denied", "host": off, "method": "GET", "status": 403}); err != nil {
			return err
		}
		if n := echo.acceptCount(); n != 0 {
			return fmt.Errorf("upstream accepted %d conns, want 0", n)
		}
		if n := h.dns.queries(off); n != 0 {
			return fmt.Errorf("%s was resolved %d times before its allowlist refusal, want 0", off, n)
		}
		return nil
	})
}

// privateAddress403: an allowlisted name that resolves to a loopback
// address is refused as destination_private when no permit prefix covers it,
// and nothing is dialled. So is an allowlisted private IP literal.
//
// pinned against: skipping the CheckAddr loop in resolveAndCheck.
func privateAddress403(ctx context.Context, t Target) error {
	var echo *echoUpstream
	const priv = "priv.test"
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		if err := h.dns.answer(priv, "127.0.0.1"); err != nil {
			return err
		}
		h.env[EnvAllow] = fmt.Sprintf("%s:%d,127.0.0.1:%d", priv, echo.port(), echo.port())
		return nil // no MOCA_EGRESS_PERMIT_CIDRS
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		for _, host := range []string{priv, "127.0.0.1"} {
			hp := net.JoinHostPort(host, strconv.Itoa(echo.port()))
			g, err := h.dial(v)
			if err != nil {
				return err
			}
			r, err := g.connect(hp)
			g.close()
			if err != nil {
				return err
			}
			if err := wantRefusal(r, 403, "destination_private", host); err != nil {
				return fmt.Errorf("CONNECT %s: %w", hp, err)
			}
			if _, err := h.wait(event{"decision": "destination_private", "host": host, "status": 403}); err != nil {
				return err
			}
		}
		if n := echo.acceptCount(); n != 0 {
			return fmt.Errorf("upstream accepted %d conns, want 0", n)
		}
		return nil
	})
}

// metadataAddress403EvenIfPermitted: the link-local metadata address is
// refused even when a permit prefix covers it, as an IP literal and behind an
// allowlisted name.
//
// pinned against: treating link-local unicast as permit-able (restricted)
// rather than always refused in CheckAddr.
func metadataAddress403EvenIfPermitted(ctx context.Context, t Target) error {
	const meta, metaIP = "meta.test", "169.254.169.254"
	return run(ctx, t, func(h *harness) error {
		if err := h.dns.answer(meta, metaIP); err != nil {
			return err
		}
		h.env[EnvAllow] = fmt.Sprintf("%s:80,%s:443,%s:80", metaIP, metaIP, meta)
		h.env[EnvPermit] = "169.254.0.0/16,0.0.0.0/0"
		return nil
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		r, err := g.get("http://" + metaIP + "/latest/meta-data/")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_private", metaIP); err != nil {
			return fmt.Errorf("GET http://%s/: %w", metaIP, err)
		}
		g, err = h.dial(v)
		if err != nil {
			return err
		}
		r, err = g.connect(metaIP + ":443")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_private", metaIP); err != nil {
			return fmt.Errorf("CONNECT %s:443: %w", metaIP, err)
		}
		g, err = h.dial(v)
		if err != nil {
			return err
		}
		r, err = g.get("http://" + meta + "/latest/meta-data/")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_private", meta); err != nil {
			return fmt.Errorf("GET http://%s/: %w", meta, err)
		}
		for _, host := range []string{metaIP, meta} {
			if _, err := h.wait(event{"decision": "destination_private", "host": host, "status": 403}); err != nil {
				return err
			}
		}
		return nil
	})
}

// dnsRebindingResolvedOnce: the name answers 127.0.0.1 (the permitted fake
// upstream) first and 10.0.0.9 (private, not permitted) for every later A
// query. The proxy must resolve once, check that answer and dial exactly it:
// the A-query count is 1, the tunnel reaches the fake upstream, and the
// audit's dial_addr is the checked address.
//
// The count is exact because the fake DNS answers at once: Go's resolver
// issues the A and AAAA queries in parallel for network "ip" but retries only
// after a timeout (5 s by default), so it sends one A query per lookup.
//
// pinned against: resolving the name a second time in proxyConn.handle and
// dialling the second answer.
func dnsRebindingResolvedOnce(ctx context.Context, t Target) error {
	var echo *echoUpstream
	const rebind = "rebind.test"
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		if err := h.dns.answer(rebind, "127.0.0.1"); err != nil {
			return err
		}
		if err := h.dns.answer(rebind, "10.0.0.9"); err != nil {
			return err
		}
		h.env[EnvAllow] = fmt.Sprintf("%s:%d", rebind, echo.port())
		h.env[EnvPermit] = "127.0.0.1/32"
		return nil
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		defer g.close()
		hp := net.JoinHostPort(rebind, strconv.Itoa(echo.port()))
		r, err := g.connect(hp)
		if err != nil {
			return err
		}
		if r.status != 200 {
			return fmt.Errorf("CONNECT %s: status %d %q, want 200 to the first, checked answer", hp, r.status, r.body)
		}
		if err := g.echoThrough([]byte("rebind")); err != nil {
			return err
		}
		g.close()
		want := net.JoinHostPort("127.0.0.1", strconv.Itoa(echo.port()))
		if _, err := h.wait(event{"decision": "tunnel", "host": rebind, "dial_addr": want}); err != nil {
			return err
		}
		if n := h.dns.queries(rebind); n != 1 {
			return fmt.Errorf("%s got %d A queries, want exactly 1", rebind, n)
		}
		return nil
	})
}

// perVMConnCap429: with MOCA_EGRESS_MAX_CONNS_PER_VM=2 and two live tunnels
// on vm-a, a third conn on vm-a is refused 429 conn_cap, naming the VM,
// while vm-b of the same session is unaffected.
//
// pinned against: comparing the live-conn count with > instead of >= in
// Proxy.admit.
func perVMConnCap429(ctx context.Context, t Target) error {
	var echo *echoUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		h.env[EnvMaxConns] = "2"
		return h.loopbackUpstreams(echo.port())
	}, func(h *harness) error {
		a, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		b, err := h.register("vm-b", "sid-a")
		if err != nil {
			return err
		}
		hp := net.JoinHostPort(upName, strconv.Itoa(echo.port()))
		open := func(v vm) (*guest, error) {
			g, err := h.dial(v)
			if err != nil {
				return nil, err
			}
			r, err := g.connect(hp)
			if err == nil && r.status != 200 {
				err = fmt.Errorf("CONNECT on %s: status %d %q, want 200", v.id, r.status, r.body)
			}
			if err != nil {
				g.close()
				return nil, err
			}
			return g, nil
		}
		for i := 0; i < 2; i++ {
			g, err := open(a)
			if err != nil {
				return fmt.Errorf("tunnel %d: %w", i+1, err)
			}
			defer g.close()
		}
		g, err := h.dial(a)
		if err != nil {
			return err
		}
		r, err := g.connect(hp)
		g.close()
		if err != nil {
			return fmt.Errorf("third conn on vm-a: %w", err)
		}
		if err := wantRefusal(r, 429, "conn_cap", "vm-a"); err != nil {
			return fmt.Errorf("third conn on vm-a: %w", err)
		}
		if _, err := h.wait(event{"decision": "conn_cap", "vm_id": "vm-a", "sid": "sid-a", "status": 429}); err != nil {
			return err
		}
		gb, err := open(b)
		if err != nil {
			return fmt.Errorf("vm-b, under its own cap: %w", err)
		}
		gb.close()
		return nil
	})
}

// perSessionRequestCap429: with MOCA_EGRESS_MAX_REQUESTS_PER_SESSION=3, the
// fourth request of a session is refused 429 request_cap even though it
// spans two VMs and two conns; another session still gets through. The
// refused request never reaches the upstream.
//
// pinned against: charging requests per VM id instead of per session in
// proxyConn.handle.
func perSessionRequestCap429(ctx context.Context, t Target) error {
	var up *httpUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if up, err = h.httpUp(); err != nil {
			return err
		}
		h.env[EnvMaxRequests] = "3"
		return h.loopbackUpstreams(up.port())
	}, func(h *harness) error {
		a, err := h.register("vm-a", "sid-s")
		if err != nil {
			return err
		}
		b, err := h.register("vm-b", "sid-s")
		if err != nil {
			return err
		}
		c, err := h.register("vm-c", "sid-t")
		if err != nil {
			return err
		}
		ga, err := h.dial(a)
		if err != nil {
			return err
		}
		defer ga.close()
		gb, err := h.dial(b)
		if err != nil {
			return err
		}
		defer gb.close()
		steps := []struct {
			g    *guest
			path string
		}{{ga, "/1"}, {ga, "/2"}, {gb, "/3"}}
		for _, s := range steps {
			r, err := s.g.get(upURL(up.port(), s.path))
			if err != nil {
				return fmt.Errorf("request %s: %w", s.path, err)
			}
			if r.status != 200 {
				return fmt.Errorf("request %s: status %d %q, want 200", s.path, r.status, r.body)
			}
		}
		r, err := gb.get(upURL(up.port(), "/4"))
		if err != nil {
			return fmt.Errorf("request /4: %w", err)
		}
		if err := wantRefusal(r, 429, "request_cap", upName); err != nil {
			return fmt.Errorf("request /4: %w", err)
		}
		if _, err := h.wait(event{"decision": "request_cap", "sid": "sid-s", "vm_id": "vm-b", "status": 429}); err != nil {
			return err
		}
		gc, err := h.dial(c)
		if err != nil {
			return err
		}
		defer gc.close()
		if r, err := gc.get(upURL(up.port(), "/other")); err != nil || r.status != 200 {
			return fmt.Errorf("another session's request: status %d, %v; want 200", r.status, err)
		}
		for _, rq := range up.requests() {
			if rq.path == "/4" {
				return errors.New("the capped request reached the upstream")
			}
		}
		return nil
	})
}

// unregisterAbortsInflight: Unregister closes vm-a's listener and every live
// conn of vm-a (a tunnel and a plain-HTTP request the upstream is still
// holding) before it returns. Each conn yields exactly one aborted event and
// no other terminal event; vm-b is untouched.
//
// pinned against: Proxy.Unregister closing the listener but not aborting the
// VM's live conns.
func unregisterAbortsInflight(ctx context.Context, t Target) error {
	var echo *echoUpstream
	var up *httpUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		if up, err = h.httpUp(); err != nil {
			return err
		}
		return h.loopbackUpstreams(echo.port(), up.port())
	}, func(h *harness) error {
		a, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		b, err := h.register("vm-b", "sid-b")
		if err != nil {
			return err
		}
		hp := net.JoinHostPort(upName, strconv.Itoa(echo.port()))
		tun, err := h.dial(a)
		if err != nil {
			return err
		}
		defer tun.close()
		if r, err := tun.connect(hp); err != nil || r.status != 200 {
			return fmt.Errorf("tunnel on vm-a: status %d, %v", r.status, err)
		}
		if err := tun.echoThrough([]byte("live")); err != nil {
			return err
		}
		slow, err := h.dial(a)
		if err != nil {
			return err
		}
		defer slow.close()
		raw := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s:%d\r\n\r\n", upURL(up.port(), "/slow"), upName, up.port())
		if _, err := slow.c.Write([]byte(raw)); err != nil {
			return err
		}
		select {
		case <-up.slowArrived:
		case <-time.After(eventWait):
			return errors.New("the in-flight request never reached the upstream")
		}
		other, err := h.dial(b)
		if err != nil {
			return err
		}
		defer other.close()
		if r, err := other.connect(hp); err != nil || r.status != 200 {
			return fmt.Errorf("tunnel on vm-b: status %d, %v", r.status, err)
		}

		if err := h.client.Unregister(h.ctx, "vm-a"); err != nil {
			return fmt.Errorf("unregister vm-a: %w", err)
		}
		if c, err := net.DialTimeout("unix", a.path, time.Second); err == nil {
			_ = c.Close()
			return errors.New("vm-a's socket still accepts after Unregister returned")
		}
		if err := tun.closedWithin(eventWait); err != nil {
			return fmt.Errorf("vm-a's tunnel after Unregister: %w", err)
		}
		if err := slow.closedWithin(eventWait); err != nil {
			return fmt.Errorf("vm-a's in-flight request after Unregister: %w", err)
		}
		if _, err := h.wait(event{"decision": "aborted", "vm_id": "vm-a", "method": "CONNECT"}); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "aborted", "vm_id": "vm-a", "method": "GET"}); err != nil {
			return err
		}
		if err := h.settle(); err != nil {
			return err
		}
		if n := h.count(event{"decision": "aborted", "vm_id": "vm-a"}); n != 2 {
			return fmt.Errorf("%d aborted events for vm-a, want 2: %s", n, h.seenText())
		}
		for _, d := range []string{"tunnel", "forward"} {
			if n := h.count(event{"decision": d, "vm_id": "vm-a"}); n != 0 {
				return fmt.Errorf("%d %s events for vm-a besides aborted, want 0: %s", n, d, h.seenText())
			}
		}
		if n := h.count(event{"vm_id": "vm-b"}); n != 0 {
			return fmt.Errorf("vm-b's live tunnel was ended by vm-a's Unregister: %s", h.seenText())
		}
		if err := other.echoThrough([]byte("still here")); err != nil {
			return fmt.Errorf("vm-b after vm-a's Unregister: %w", err)
		}
		return nil
	})
}

// connectTunnelOpaque: after a checked CONNECT the proxy is a byte pipe. Bytes
// pipelined behind the CONNECT request, bytes that look like HTTP, and binary
// data all arrive unchanged; a half-close travels upstream while the echo still
// flows back, ending in a clean EOF; the tunnel event
// counts the bytes each way and names the dialled address.
//
// pinned against: splicing from the raw guest conn instead of the buffered
// reader in tunnel, which drops the bytes pipelined behind the CONNECT; and
// splice closing both conns on the first EOF instead of half-closing, which
// loses the trailing echo.
func connectTunnelOpaque(ctx context.Context, t Target) error {
	var echo *echoUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		return h.loopbackUpstreams(echo.port())
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		defer g.close()
		hp := net.JoinHostPort(upName, strconv.Itoa(echo.port()))
		early := []byte("GET /not-parsed HTTP/1.1\r\nHost: evil.test\r\nX-Moca-Session: forged\r\n\r\n")
		raw := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", hp, hp)
		if _, err := g.c.Write(append([]byte(raw), early...)); err != nil {
			return err
		}
		r, err := g.readConnectReply()
		if err != nil {
			return err
		}
		if r.status != 200 {
			return fmt.Errorf("CONNECT %s: status %d %q, want 200", hp, r.status, r.body)
		}
		got := make([]byte, len(early))
		if _, err := io.ReadFull(g.br, got); err != nil {
			return fmt.Errorf("pipelined bytes: %w", err)
		}
		if string(got) != string(early) {
			return fmt.Errorf("pipelined bytes came back as %q, want %q", got, early)
		}
		bin := make([]byte, 256<<10)
		if _, err := rand.Read(bin); err != nil {
			return err
		}
		if err := g.echoThrough(bin); err != nil {
			return err
		}
		// Half-close: a trailing chunk, then CloseWrite at once, without
		// waiting for its echo. The proxy must carry the EOF upstream and keep
		// the downstream direction open, so the echo of the chunk still
		// arrives, followed by a clean EOF (not a reset).
		trail := make([]byte, 64<<10)
		if _, err := rand.Read(trail); err != nil {
			return err
		}
		if _, err := g.c.Write(trail); err != nil {
			return fmt.Errorf("trailing write: %w", err)
		}
		if err := g.c.(*net.UnixConn).CloseWrite(); err != nil {
			return err
		}
		_ = g.c.SetReadDeadline(time.Now().Add(eventWait))
		rest, err := io.ReadAll(g.br)
		if err != nil {
			return fmt.Errorf("half-close through the tunnel: read after CloseWrite ended with %v after %d bytes, want a clean EOF", err, len(rest))
		}
		if !bytes.Equal(rest, trail) {
			return fmt.Errorf("half-close through the tunnel: got %d bytes after CloseWrite, want the %d-byte trailing echo", len(rest), len(trail))
		}
		total := len(early) + len(bin) + len(trail)
		dial := net.JoinHostPort("127.0.0.1", strconv.Itoa(echo.port()))
		if _, err := h.wait(event{"decision": "tunnel", "status": 200, "host": upName, "method": "CONNECT",
			"dial_addr": dial, "bytes_up": total, "bytes_down": total}); err != nil {
			return err
		}
		return nil
	})
}

// plainHTTPStripsProxyAndMocaHeaders: an absolute-form http:// request is
// forwarded with every Proxy-* header (not only the hop-by-hop Proxy-Authorization
// and Proxy-Connection), the hop-by-hop headers, the headers Connection names and
// every X-Moca-* header removed, and the upstream's X-Moca-* and Proxy-* response
// headers never reach the guest, so an upstream cannot forge a named refusal.
// Other headers pass both ways.
//
// pinned against: dropping the X-Moca-* loop from scrubHeaders, and dropping its
// Proxy-* prefix loop (Proxy-Tenant then reaches upstream).
func plainHTTPStripsProxyAndMocaHeaders(ctx context.Context, t Target) error {
	var up *httpUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if up, err = h.httpUp(); err != nil {
			return err
		}
		return h.loopbackUpstreams(up.port())
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		defer g.close()
		r, err := g.get(upURL(up.port(), "/hdr"),
			"Proxy-Authorization: forged",
			"Proxy-Connection: keep-alive",
			"Connection: keep-alive, X-Named-Hop",
			"X-Named-Hop: 1",
			"Keep-Alive: timeout=5",
			"X-Moca-Session: forged",
			"x-moca-egress-error: forged",
			"Proxy-Tenant: other",
			"proxy-remote-user: root",
			"X-Kept-Request: 1")
		if err != nil {
			return err
		}
		if r.status != 200 || r.body != "ok" {
			return fmt.Errorf("status %d body %q, want 200 \"ok\"", r.status, r.body)
		}
		for k := range r.header {
			lk := strings.ToLower(k)
			if strings.HasPrefix(lk, "x-moca-") || strings.HasPrefix(lk, "proxy-") {
				return fmt.Errorf("guest received upstream response header %s: %v", k, r.header[k])
			}
		}
		if r.header.Get("X-Kept") != "1" {
			return fmt.Errorf("response header X-Kept was dropped: %v", r.header)
		}
		reqs := up.requests()
		if len(reqs) != 1 {
			return fmt.Errorf("upstream saw %d requests, want 1", len(reqs))
		}
		rq := reqs[0]
		for k := range rq.header {
			lk := strings.ToLower(k)
			switch {
			case strings.HasPrefix(lk, "x-moca-"), strings.HasPrefix(lk, "proxy-"),
				lk == "keep-alive", lk == "x-named-hop":
				return fmt.Errorf("upstream received request header %s: %v", k, rq.header[k])
			}
		}
		if rq.header.Get("X-Kept-Request") != "1" {
			return fmt.Errorf("request header X-Kept-Request was dropped: %v", rq.header)
		}
		if want := fmt.Sprintf("%s:%d", upName, up.port()); rq.host != want {
			return fmt.Errorf("upstream Host %q, want %q", rq.host, want)
		}
		_, err = h.wait(event{"decision": "forward", "status": 200, "path": "/hdr"})
		return err
	})
}

// auditQueryRemoved: the audit path carries no query string and no userinfo,
// for a forwarded request and for a refused one, while the forwarded request
// itself reaches the upstream with its query intact.
//
// pinned against: RedactPath returning the request URI (path and query).
func auditQueryRemoved(ctx context.Context, t Target) error {
	var up *httpUpstream
	const inQuery, inUserinfo = "sentinel-query-value", "sentinel-userinfo-value"
	return run(ctx, t, func(h *harness) (err error) {
		if up, err = h.httpUp(); err != nil {
			return err
		}
		return h.loopbackUpstreams(up.port())
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		u := fmt.Sprintf("http://user:%s@%s:%d/a/b%%20c?token=%s&x=1", inUserinfo, upName, up.port(), inQuery)
		r, err := g.get(u)
		g.close()
		if err != nil {
			return err
		}
		if r.status != 200 {
			return fmt.Errorf("forwarded request: status %d %q, want 200", r.status, r.body)
		}
		g, err = h.dial(v)
		if err != nil {
			return err
		}
		r, err = g.get("http://off.test/refused?token=" + inQuery)
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_denied", "off.test"); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "forward", "path": "/a/b%20c", "host": upName}); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "destination_denied", "path": "/refused", "host": "off.test"}); err != nil {
			return err
		}
		if err := h.settle(); err != nil {
			return err
		}
		for _, m := range h.seen {
			j, _ := json.Marshal(m)
			if s := string(j); strings.Contains(s, inQuery) || strings.Contains(s, inUserinfo) || strings.Contains(s, "token=") {
				return fmt.Errorf("audit event carries the query or userinfo: %s", s)
			}
		}
		reqs := up.requests()
		if len(reqs) != 1 || reqs[0].rawQuery != "token="+inQuery+"&x=1" {
			return fmt.Errorf("upstream requests %+v, want one with the query intact", reqs)
		}
		return nil
	})
}

// grantRefusedUnderSingle: under MOCA_TENANCY=single this slice has no
// grants, so a Register carrying one is refused bad_request and binds
// nothing (the same VM id then registers cleanly). MOCA_TENANCY=multi is a
// boot failure.
//
// pinned against: dropping the non-empty-grant refusal from Proxy.Register.
func grantRefusedUnderSingle(ctx context.Context, t Target) error {
	var echo *echoUpstream
	err := run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		h.env[EnvTenancy] = "single"
		return h.loopbackUpstreams(echo.port())
	}, func(h *harness) error {
		ln, f, _, err := h.newVMListener("vm-g")
		if err != nil {
			return err
		}
		defer ln.Close()
		defer f.Close()
		err = h.client.Register(h.ctx, "vm-g", "sid-a", []byte("a-grant"), f)
		var re *control.RefusalError
		if !errors.As(err, &re) || re.Code != "bad_request" {
			return fmt.Errorf("Register with a grant: %v, want a bad_request refusal", err)
		}
		if _, err := h.register("vm-g", "sid-a"); err != nil {
			return fmt.Errorf("the refused registration left a binding: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	h, err := newHarness(ctx)
	if err != nil {
		return err
	}
	defer h.close()
	h.env[EnvTenancy] = "multi"
	h.env[EnvAllow] = "up.test"
	inst, err := t.Start(ctx, h.env)
	if err == nil {
		_ = inst.Stop()
		return errors.New("MOCA_TENANCY=multi: the instance started, want a boot failure")
	}
	if !strings.Contains(err.Error(), EnvTenancy) {
		return fmt.Errorf("MOCA_TENANCY=multi: boot failure %q does not name %s", err, EnvTenancy)
	}
	return nil
}

// connectTunnelIdleDeadline: with MOCA_EGRESS_IDLE_TIMEOUT_S=1 and
// MOCA_EGRESS_MAX_CONNS_PER_VM=1, a tunnel to an upstream that says nothing is
// closed, its tunnel event is emitted, and the slot it held comes back -- a
// second CONNECT on the same VM succeeds where it would otherwise be refused
// conn_cap. An active tunnel is unaffected, which the in-process suite pins
// separately: the bound is refreshed per read, not absolute.
//
// pinned against: clearing the header read deadline (handler.go) without
// replacing it, so splice/copyCounted blocks in Read for the VM's lifetime.
func connectTunnelIdleDeadline(ctx context.Context, t Target) error {
	var silent *silentUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if silent, err = h.silent(); err != nil {
			return err
		}
		h.env[EnvIdleTimeout] = "1"
		h.env[EnvMaxConns] = "1"
		return h.loopbackUpstreams(silent.port())
	}, func(h *harness) error {
		v, err := h.register("vm-i", "sid-i")
		if err != nil {
			return err
		}
		hp := net.JoinHostPort(upName, strconv.Itoa(silent.port()))
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		defer g.close()
		r, err := g.connect(hp)
		if err != nil {
			return err
		}
		if r.status != 200 {
			return fmt.Errorf("CONNECT: status %d %q, want 200", r.status, r.body)
		}
		// Neither side sends anything. The tunnel event is emitted when the
		// splice returns, so its arrival is the proof the copy loops
		// unblocked; without the bound it never arrives.
		if _, err := h.wait(event{"decision": "tunnel", "vm_id": "vm-i", "sid": "sid-i", "status": 200}); err != nil {
			return fmt.Errorf("idle tunnel was not closed: %w", err)
		}
		if err := g.closedWithin(eventWait); err != nil {
			return fmt.Errorf("guest conn after the idle bound: %w", err)
		}
		// The slot is only free if the cap admits another conn: with
		// MaxConns=1 this would be conn_cap if the expired tunnel still held
		// its slot.
		g2, err := h.dial(v)
		if err != nil {
			return err
		}
		defer g2.close()
		r2, err := g2.connect(hp)
		if err != nil {
			return err
		}
		if r2.status != 200 {
			return fmt.Errorf("second CONNECT: status %d %q, want 200 (the expired tunnel kept its slot)", r2.status, r2.body)
		}
		return nil
	})
}

// forwardResponseHeaderTimeout: with
// MOCA_EGRESS_RESPONSE_HEADER_TIMEOUT_S=1, a forwarded request to an upstream
// that accepts the connection and never answers is refused 502
// upstream_unreachable rather than held open. The refusal is the same named
// one an unreachable upstream already gets: a timeout adds no new decision
// value, so the audit shape is unchanged.
//
// pinned against: an http.Transport built per request (forward.go) with no
// ResponseHeaderTimeout, so RoundTrip waits on a silent upstream forever.
func forwardResponseHeaderTimeout(ctx context.Context, t Target) error {
	var silent *silentUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if silent, err = h.silent(); err != nil {
			return err
		}
		h.env[EnvRespHeaderTime] = "1"
		// Long, so what fires is the header bound and not the idle one.
		h.env[EnvIdleTimeout] = "60"
		return h.loopbackUpstreams(silent.port())
	}, func(h *harness) error {
		v, err := h.register("vm-r", "sid-r")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		defer g.close()
		r, err := g.get(upURL(silent.port(), "/never"))
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 502, "upstream_unreachable", upName); err != nil {
			return err
		}
		_, err = h.wait(event{"decision": "upstream_unreachable", "vm_id": "vm-r", "sid": "sid-r", "status": 502})
		return err
	})
}

// noSubject reports whether an event carries no subject: sub absent or "".
func noSubject(m map[string]any) bool {
	v, ok := m["sub"]
	return !ok || v == ""
}

// mayHaveSubject reports whether an event may carry sub: a credential_injected
// event, or upstream_unreachable after injection (it names the credential).
func mayHaveSubject(m map[string]any) bool {
	c, _ := m["credential"].(string)
	d := m["decision"]
	return c != "" && (d == "credential_injected" || d == "upstream_unreachable")
}

// ---- interception cases (SBX0.2b spec section 10.2) ----
//
// Each runs with credential mode on: a fake control plane, an interception CA
// and a TLS upstream signed by a CA the binary is given as its upstream roots.
// The cases above never set these, so they run as v0.8.0 did.

// ttlWait is how long a case waits for a cached answer to lapse. A lookup
// answer's ttlSeconds is floored at five seconds by moca-egress; an
// implementation with a shorter floor also passes.
const ttlWait = 5500 * time.Millisecond

// lastReq is the last request the upstream saw for path.
func lastReq(u *httpUpstream, path string) (seenRequest, bool) {
	rs := u.requests()
	for i := len(rs) - 1; i >= 0; i-- {
		if rs[i].path == path {
			return rs[i], true
		}
	}
	return seenRequest{}, false
}

// wantAuth checks that the upstream saw exactly one Authorization, equal to
// want ("" means none), for its last request at path. A failure names the
// header and counts, never a value: the suite runs against real deployments.
func wantAuth(u *httpUpstream, path, want string) error {
	return wantHeader(u, path, "Authorization", want)
}

// wantHeader is wantAuth for any header name. Messages say matched, not
// matched or absent, with counts, and carry no header value.
func wantHeader(u *httpUpstream, path, name, want string) error {
	rq, ok := lastReq(u, path)
	if !ok {
		return fmt.Errorf("upstream saw no request for %s", path)
	}
	got := rq.values(name)
	if want == "" {
		if len(got) != 0 {
			return fmt.Errorf("%s reached the upstream with %d %s header(s), want none", path, len(got), name)
		}
		return nil
	}
	switch {
	case len(got) == 0:
		return fmt.Errorf("%s reached the upstream with %s absent, want it set", path, name)
	case len(got) != 1:
		return fmt.Errorf("%s reached the upstream with %d %s headers, want exactly 1", path, len(got), name)
	case got[0] != want:
		return fmt.Errorf("%s reached the upstream with one %s header that is not the expected value (not matched)", path, name)
	}
	return nil
}

// getOK sends GET target and requires 200.
func (g *guest) getOK(target string, hp string, extra ...string) error {
	r, err := g.req(http.MethodGet, target, hp, extra...)
	if err != nil {
		return fmt.Errorf("GET %s: %w", target, err)
	}
	if r.status != 200 {
		return fmt.Errorf("GET %s: status %d (body %d bytes), want 200", target, r.status, len(r.body))
	}
	return nil
}

// credentialInjectedPlaceholderOverwritten: on a host the owner has a
// credential for, the guest's own Authorization (the placeholder) never
// reaches the upstream: it sees the credential's value, once. One
// credential_injected event per request names the credential and the
// subject, and no event carries a value.
//
// pinned against: not deleting the guest's Authorization header before the
// credential's headers are set, and setting with Header.Add instead of Set
// (the upstream then saw both values).
func credentialInjectedPlaceholderOverwritten(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 60, cred("gh", "/", "Authorization: Bearer real-token-1"))
		}
		return err
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.tlsGuest(v, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		defer g.close()
		for _, p := range []string{"/x", "/y"} {
			if err := g.getOK(p, w.hp, "Authorization: Bearer moca-placeholder"); err != nil {
				return err
			}
			if err := wantAuth(w.up, p, "Bearer real-token-1"); err != nil {
				return err
			}
			rq, _ := lastReq(w.up, p)
			for k, vs := range rq.header {
				for _, val := range vs {
					if strings.Contains(val, "moca-placeholder") {
						return fmt.Errorf("the placeholder reached the upstream in header %s", k)
					}
				}
			}
			if _, err := h.wait(event{"decision": "credential_injected", "credential": "gh", "sub": "user-sid-a",
				"path": p, "status": 200, "vm_id": "vm-a", "sid": "sid-a", "host": upName}); err != nil {
				return err
			}
		}
		if err := h.settle(); err != nil {
			return err
		}
		if n := h.count(event{"decision": "credential_injected"}); n != 2 {
			return fmt.Errorf("%d credential_injected events for 2 injections, want 2", n)
		}
		if txt := h.seenText(); strings.Contains(txt, "real-token-1") {
			return fmt.Errorf("a credential value reached the audit stream")
		}
		return nil
	})
}

// upstreamDroppedAfterInjection502: an upstream that reads an injected request
// and closes without answering is refused 502 upstream_unreachable. Its event
// keeps credential and sub, since the token may have been sent, and is not
// counted as a credential_injected event.
//
// pinned against: clearing Credential and Sub on the refusal after injection
// (the audit lost who the sent token belonged to).
func upstreamDroppedAfterInjection502(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 60, cred("gh", "/", "Authorization: Bearer real-token-1"))
		}
		return err
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.tlsGuest(v, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		defer g.close()
		r, err := g.req(http.MethodGet, "/drop", w.hp)
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 502, "upstream_unreachable", upName); err != nil {
			return err
		}
		if err := wantAuth(w.up, "/drop", "Bearer real-token-1"); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "upstream_unreachable", "credential": "gh", "sub": "user-sid-a",
			"status": 502, "vm_id": "vm-a", "sid": "sid-a", "host": upName}); err != nil {
			return err
		}
		if err := h.settle(); err != nil {
			return err
		}
		if n := h.count(event{"decision": "credential_injected"}); n != 0 {
			return fmt.Errorf("%d credential_injected events for a request that got no answer, want 0", n)
		}
		return nil
	})
}

// noCredentialTunnelledOpaque: a host the owner holds no credential for is an
// opaque tunnel. The guest handshakes with the upstream's own certificate (it
// does not trust the interception CA at all) and the upstream sees the
// guest's request unchanged. A 404 no_credential is a clean "none".
//
// pinned against: intercepting every CONNECT regardless of the lookup (the
// guest's handshake fails: the leaf is signed by the interception CA).
func noCredentialTunnelledOpaque(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		return err // the fake answers 404 no_credential for everything
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.tlsGuest(v, w.hp, trusting(w.upCA.pool))
		if err != nil {
			return err
		}
		defer g.close()
		if err := g.getOK("/own", w.hp, "Authorization: Bearer guests-own"); err != nil {
			return err
		}
		if err := wantAuth(w.up, "/own", "Bearer guests-own"); err != nil {
			return err
		}
		g.close() // a tunnel's event is written when it ends
		if _, err := h.wait(event{"decision": "tunnel", "method": "CONNECT", "host": upName, "sid": "sid-a"}); err != nil {
			return err
		}
		return nil
	})
}

// lookupError503NoDial: when the lookup fails, the answer is
// 503 credential_unavailable for CONNECT and for plain HTTP, and nothing is
// dialled. An unknown credential state is never a tunnel.
//
// pinned against: treating a lookup error as "no credential" in
// proxyConn.handle (the CONNECT was tunnelled, the upstream accepted a conn).
func lookupError503NoDial(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.cp.set("sid-a", upName, cpAnswer{status: http.StatusInternalServerError})
		}
		return err
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		r, err := g.connect(w.hp)
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 503, "credential_unavailable", upName); err != nil {
			return fmt.Errorf("CONNECT %s: %w", w.hp, err)
		}
		g, err = h.dial(v)
		if err != nil {
			return err
		}
		r, err = g.get("http://" + w.hp + "/x")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 503, "credential_unavailable", upName); err != nil {
			return fmt.Errorf("GET http://%s/x: %w", w.hp, err)
		}
		if _, err := h.wait(event{"decision": "credential_unavailable", "method": "CONNECT", "status": 503}); err != nil {
			return err
		}
		if n := w.up.acceptCount(); n != 0 {
			return fmt.Errorf("upstream accepted %d conns, want 0", n)
		}
		return nil
	})
}

// upstreamUnverified502: an intercepted host whose certificate does not
// verify against the system roots plus MOCA_EGRESS_UPSTREAM_CA answers
// 502 upstream_unverified to the CONNECT itself: no 200, so no leaf was
// minted and no TLS began, and the connection is not a tunnel.
//
// pinned against: verifying the upstream with InsecureSkipVerify (the CONNECT
// was answered 200 and the guest was served).
func upstreamUnverified502(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) error {
		var err error
		if w, err = h.enableCredentials(); err != nil {
			return err
		}
		stranger, err := newTestCA("a CA the binary was not given")
		if err != nil {
			return err
		}
		if err := w.startUpstream(h, stranger); err != nil {
			return err
		}
		w.give("sid-a", 60, cred("gh", "/", "Authorization: Bearer real-token-1"))
		return nil
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		r, err := g.connect(w.hp)
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 502, "upstream_unverified", upName); err != nil {
			return fmt.Errorf("CONNECT %s: %w", w.hp, err)
		}
		if _, err := h.wait(event{"decision": "upstream_unverified", "status": 502, "host": upName}); err != nil {
			return err
		}
		if n := len(w.up.requests()); n != 0 {
			return fmt.Errorf("upstream served %d requests, want 0", n)
		}
		return nil
	})
}

// innerHostMismatch421: inside an intercepted tunnel, a Host header that
// names anything but the CONNECT target is refused with 421, and so is a TLS
// SNI that does. Nothing reaches the upstream.
//
// pinned against: dropping the hostMatches check in icConn.next (the request
// was forwarded with the credential), and, separately, dropping the SNI check
// in the leaf callback (the handshake succeeded).
func innerHostMismatch421(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 60, cred("gh", "/", "Authorization: Bearer real-token-1"))
		}
		return err
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.tlsGuest(v, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		r, err := g.req(http.MethodGet, "/x", "evil.test")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 421, "misdirected_request", upName); err != nil {
			return fmt.Errorf("Host evil.test: %w", err)
		}
		if _, err := h.wait(event{"decision": "misdirected_request", "status": 421, "path": "/x"}); err != nil {
			return err
		}
		// A client that names another host in its SNI is refused at the handshake.
		cfg := trusting(w.icCA.pool)
		cfg.ServerName = "evil.test"
		cfg.InsecureSkipVerify = true // whatever the server offers; only its refusal is under test
		sg, err := h.dial(v)
		if err != nil {
			return err
		}
		defer sg.close()
		if cr, err := sg.connect(w.hp); err != nil || cr.status != 200 {
			return fmt.Errorf("CONNECT %s before the SNI attempt: status %d, err %v, want 200", w.hp, cr.status, err)
		}
		tc := tls.Client(connConn{sg.c, sg.br}, cfg)
		if err := tc.Handshake(); err == nil {
			return fmt.Errorf("a TLS handshake with SNI evil.test inside a tunnel to %s succeeded", w.hp)
		}
		if _, err := h.wait(event{"decision": "misdirected_request", "status": 421, "method": "CONNECT"}); err != nil {
			return fmt.Errorf("after the SNI attempt: %w", err)
		}
		if n := len(w.up.requests()); n != 0 {
			return fmt.Errorf("upstream served %d requests, want 0", n)
		}
		return nil
	})
}

// plaintextHTTPCredential403: a plain-HTTP request to a host the owner has a
// credential for is refused 403 plaintext_credential. The credential is not
// sent in the clear, and the upstream is not dialled.
//
// pinned against: forwarding the plain request (the handler's
// DecisionPlaintextCredential branch removed, so it fell through to forward).
func plaintextHTTPCredential403(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 60, cred("gh", "/", "Authorization: Bearer real-token-1"))
		}
		return err
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		r, err := g.get("http://"+w.hp+"/x", "Authorization: Bearer moca-placeholder")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "plaintext_credential", upName); err != nil {
			return fmt.Errorf("GET http://%s/x: %w", w.hp, err)
		}
		if strings.Contains(r.body, "real-token-1") {
			return fmt.Errorf("the refusal carries a credential")
		}
		if _, err := h.wait(event{"decision": "plaintext_credential", "status": 403, "method": "GET"}); err != nil {
			return err
		}
		if n := w.up.acceptCount(); n != 0 {
			return fmt.Errorf("upstream accepted %d conns, want 0", n)
		}
		return nil
	})
}

// credentialKeyedBySession: two VMs of two sessions that connect to the same
// host get their own owner's credential. The first is looked up and cached
// before the second connects, so a cache keyed by host alone would serve the
// first owner's token to the second.
//
// pinned against: the lookup cache key without SessionID (cpKey{host} only).
func credentialKeyedBySession(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 60, cred("gh-a", "/", "Authorization: Bearer token-of-a"))
			w.give("sid-b", 60, cred("gh-b", "/", "Authorization: Bearer token-of-b"))
		}
		return err
	}, func(h *harness) error {
		for _, s := range []struct{ vm, sid, tok string }{
			{"vm-a", "sid-a", "Bearer token-of-a"}, {"vm-b", "sid-b", "Bearer token-of-b"},
		} {
			v, err := h.register(s.vm, s.sid)
			if err != nil {
				return err
			}
			g, err := h.tlsGuest(v, w.hp, trusting(w.icCA.pool))
			if err != nil {
				return err
			}
			p := "/" + s.sid
			err = g.getOK(p, w.hp)
			g.close()
			if err != nil {
				return err
			}
			if err := wantAuth(w.up, p, s.tok); err != nil {
				return fmt.Errorf("session %s: %w", s.sid, err)
			}
		}
		return nil
	})
}

// lookupCachedSingleFlight: eight parallel connections of one session cost
// one lookup, a lookup answer is served from the cache until its TTL and then
// asked for again (and the new value is used), an error is not cached, and
// "none" is.
//
// pinned against: (1) no single-flight, each miss calling the control plane
// itself; (2) a cache that never expires; (3) caching a failed lookup.
func lookupCachedSingleFlight(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 1, cred("gh", "/", "Authorization: Bearer t1"))
			w.give("sid-e", 60, cred("gh", "/", "Authorization: Bearer e1"))
			w.cp.set("sid-e", upName, cpAnswer{failFirst: 1, subject: "e", ttl: 60,
				elems: []credElem{{Name: "gh", Port: w.up.port(), PathPrefix: "/",
					Headers: []credHeader{{"Authorization", "Bearer e1"}}}}})
			w.cp.setDelay(400 * time.Millisecond)
		}
		return err
	}, func(h *harness) error {
		va, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		const n = 8
		errs := make(chan error, n)
		for i := 0; i < n; i++ {
			go func() {
				g, err := h.tlsGuest(va, w.hp, trusting(w.icCA.pool))
				if err != nil {
					errs <- err
					return
				}
				defer g.close()
				errs <- g.getOK("/p", w.hp)
			}()
		}
		for i := 0; i < n; i++ {
			if err := <-errs; err != nil {
				return err
			}
		}
		if got := w.cp.count("sid-a", upName); got != 1 {
			return fmt.Errorf("%d parallel connections cost %d lookups, want 1", n, got)
		}
		w.cp.setDelay(0)

		// An error is not cached: the first lookup fails, the next one is made.
		ve, err := h.register("vm-e", "sid-e")
		if err != nil {
			return err
		}
		g, err := h.dial(ve)
		if err != nil {
			return err
		}
		r, err := g.connect(w.hp)
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 503, "credential_unavailable", upName); err != nil {
			return fmt.Errorf("first lookup failing: %w", err)
		}
		ge, err := h.tlsGuest(ve, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return fmt.Errorf("after a failed lookup: %w", err)
		}
		err = ge.getOK("/e", w.hp)
		ge.close()
		if err != nil {
			return err
		}
		if got := w.cp.count("sid-e", upName); got != 2 {
			return fmt.Errorf("a failed lookup then a good one made %d calls, want 2", got)
		}

		// "None" is cached: two connections, one lookup.
		vn, err := h.register("vm-n", "sid-n")
		if err != nil {
			return err
		}
		for i := 0; i < 2; i++ {
			g, err := h.tlsGuest(vn, w.hp, trusting(w.upCA.pool))
			if err != nil {
				return err
			}
			g.close()
		}
		if got := w.cp.count("sid-n", upName); got != 1 {
			return fmt.Errorf("two connections with no credential cost %d lookups, want 1", got)
		}

		// After the TTL the lookup is made again and its new value used.
		w.give("sid-a", 1, cred("gh", "/", "Authorization: Bearer t2"))
		time.Sleep(ttlWait)
		g, err = h.tlsGuest(va, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		err = g.getOK("/q", w.hp)
		g.close()
		if err != nil {
			return err
		}
		if err := wantAuth(w.up, "/q", "Bearer t2"); err != nil {
			return fmt.Errorf("after the TTL: %w", err)
		}
		if got := w.cp.count("sid-a", upName); got != 2 {
			return fmt.Errorf("a lookup after the TTL made %d calls in all, want 2", got)
		}
		return nil
	})
}

// credentialRevokedMidConnection401: a connection that has injected a prefix
// does not outlive its credential. After the cached answer lapses and the
// control plane no longer holds it, the next request under that prefix gets
// 401 credential_revoked with nothing sent upstream and the connection
// closed. (a) the owner holds nothing now; (b) the owner still holds "/",
// which must not take over: the request is refused, never sent with "/"'s
// headers. A fresh connection of (b) does get "/".
//
// pinned against: (a) removing the revocation loop in icConn.next (the
// request was forwarded, uninjected); (b) revoking only when the whole set is
// empty (the request was injected with "/"'s token).
func credentialRevokedMidConnection401(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 1, cred("a-only", "/a", "Authorization: Bearer a-tok"))
			w.give("sid-b", 1, cred("b-root", "/", "Authorization: Bearer b-root-tok"),
				cred("b-a", "/a", "Authorization: Bearer b-a-tok"))
		}
		return err
	}, func(h *harness) error {
		va, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		vb, err := h.register("vm-b", "sid-b")
		if err != nil {
			return err
		}
		ga, err := h.tlsGuest(va, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		defer ga.close()
		gb, err := h.tlsGuest(vb, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		defer gb.close()
		if err := ga.getOK("/a/x", w.hp); err != nil {
			return err
		}
		if err := wantAuth(w.up, "/a/x", "Bearer a-tok"); err != nil {
			return err
		}
		if err := gb.getOK("/a/x", w.hp); err != nil {
			return err
		}
		if err := wantAuth(w.up, "/a/x", "Bearer b-a-tok"); err != nil {
			return err
		}

		w.cp.set("sid-a", upName, cpAnswer{}) // (a) no set at all
		w.give("sid-b", 1, cred("b-root", "/", "Authorization: Bearer b-root-tok"))
		time.Sleep(ttlWait)

		before := len(w.up.requests())
		for _, c := range []struct {
			g    *guest
			name string
		}{{ga, "(a)"}, {gb, "(b)"}} {
			r, err := c.g.req(http.MethodGet, "/a/x", w.hp)
			if err != nil {
				return fmt.Errorf("%s: %w", c.name, err)
			}
			if err := wantRefusal(r, 401, "credential_revoked", upName); err != nil {
				return fmt.Errorf("%s: %w", c.name, err)
			}
			if err := c.g.closedWithin(2 * time.Second); err != nil {
				return fmt.Errorf("%s: after the revocation: %w", c.name, err)
			}
		}
		if after := len(w.up.requests()); after != before {
			return fmt.Errorf("%d requests reached the upstream after the revocation, want 0", after-before)
		}
		if _, err := h.wait(event{"decision": "credential_revoked", "sid": "sid-a", "status": 401, "credential": "a-only"}); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "credential_revoked", "sid": "sid-b", "status": 401, "credential": "b-a"}); err != nil {
			return err
		}
		// (b) "/" is still held: a new connection gets it.
		g, err := h.tlsGuest(vb, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		defer g.close()
		if err := g.getOK("/a/y", w.hp); err != nil {
			return err
		}
		return wantAuth(w.up, "/a/y", "Bearer b-root-tok")
	})
}

// credentialSelectedByPathPrefix: with "/" and "/a" credentials on one host
// the longest prefix on a "/" boundary wins ("/a" and "/a/x", not "/ab"). A
// request no credential covers is forwarded with nothing injected, both on a
// fresh connection and on one that has already injected "/a".
//
// pinned against: selectFor falling back to the first element when no prefix
// matches (the "/b"-style request carried "/a"'s token), and, separately,
// selectFor preferring the shortest prefix.
func credentialSelectedByPathPrefix(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 60, cred("root", "/", "Authorization: Bearer root-tok"),
				cred("a", "/a", "Authorization: Bearer a-tok"))
			w.give("sid-b", 60, cred("a", "/a", "Authorization: Bearer a-tok"))
		}
		return err
	}, func(h *harness) error {
		va, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		vb, err := h.register("vm-b", "sid-b")
		if err != nil {
			return err
		}
		ga, err := h.tlsGuest(va, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		defer ga.close()
		for _, c := range []struct{ path, want string }{
			{"/a/x", "Bearer a-tok"}, {"/b", "Bearer root-tok"}, {"/ab", "Bearer root-tok"}, {"/a", "Bearer a-tok"},
		} {
			if err := ga.getOK(c.path, w.hp); err != nil {
				return err
			}
			if err := wantAuth(w.up, c.path, c.want); err != nil {
				return err
			}
		}
		// Only "/a" is held. A fresh connection: "/other" is not covered.
		gb, err := h.tlsGuest(vb, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		defer gb.close()
		if err := gb.getOK("/other", w.hp); err != nil {
			return err
		}
		if err := wantAuth(w.up, "/other", ""); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "forward", "path": "/other", "sid": "sid-b", "status": 200}); err != nil {
			return err
		}
		// A connection that has injected "/a" and then asks for "/other2".
		gc, err := h.tlsGuest(vb, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		defer gc.close()
		if err := gc.getOK("/a/x", w.hp); err != nil {
			return err
		}
		if err := wantAuth(w.up, "/a/x", "Bearer a-tok"); err != nil {
			return fmt.Errorf("premise (this conn injected /a): %w", err)
		}
		if err := gc.getOK("/other2", w.hp); err != nil {
			return err
		}
		if err := wantAuth(w.up, "/other2", ""); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "forward", "path": "/other2", "sid": "sid-b", "status": 200}); err != nil {
			return err
		}
		return nil
	})
}

// pathTraversalRefusedWhenPathScoped: while the owner holds a credential with
// a path prefix on the host, a request-target whose raw form could be
// normalised by an upstream into another path is refused 400 and never sent:
// dot segments plain, percent-encoded and double-encoded, path parameters,
// backslashes, an empty segment and a fragment. With only a "/" credential
// the same dot segments are forwarded, because no prefix can be bypassed.
//
// pinned against: removing the rawPathUnsafe check from icConn.next (every
// target was forwarded), and, separately, leaving "#" out of its character
// set (only "/a#/b" was forwarded).
func pathTraversalRefusedWhenPathScoped(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 60, cred("a", "/a", "Authorization: Bearer a-tok"))
			w.give("sid-b", 60, cred("root", "/", "Authorization: Bearer root-tok"))
		}
		return err
	}, func(h *harness) error {
		va, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		vb, err := h.register("vm-b", "sid-b")
		if err != nil {
			return err
		}
		targets := []string{"/a/../b", "/a/%2e%2e/b", "/a/%252e%252e/b", "/a/..;/b", "/a;x/../b", `/a\b`, "//a/x", "/a#/b"}
		for _, tg := range targets {
			g, err := h.tlsGuest(va, w.hp, trusting(w.icCA.pool))
			if err != nil {
				return err
			}
			r, err := g.req(http.MethodGet, tg, w.hp)
			g.close()
			if err != nil {
				return fmt.Errorf("%s: %w", tg, err)
			}
			if err := wantRefusal(r, 400, "bad_request", upName); err != nil {
				return fmt.Errorf("GET %s: %w", tg, err)
			}
		}
		if n := len(w.up.requests()); n != 0 {
			return fmt.Errorf("%d refused targets reached the upstream, want 0", n)
		}
		// The guard is not a blanket refusal: a clean path is injected.
		g, err := h.tlsGuest(va, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		err = g.getOK("/a/x", w.hp)
		g.close()
		if err != nil {
			return err
		}
		if err := wantAuth(w.up, "/a/x", "Bearer a-tok"); err != nil {
			return err
		}
		// A "/"-only host has no prefix to bypass.
		g, err = h.tlsGuest(vb, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		defer g.close()
		before := len(w.up.requests())
		if err := g.getOK("/a/../b", w.hp); err != nil {
			return fmt.Errorf("a host with only a / credential: %w", err)
		}
		if after := len(w.up.requests()); after != before+1 {
			return fmt.Errorf("/a/../b on a / credential host: %d requests reached the upstream, want 1", after-before)
		}
		return nil
	})
}

// credentialSetsEveryHeader: a credential with two headers sets both,
// replacing whatever values the guest sent for them.
//
// pinned against: the injection loop in icConn.next stopping after the first
// header.
func credentialSetsEveryHeader(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 60,
				cred("two", "/", "Authorization: Bearer two-tok", "X-Api-Key: key-1"),
				cred("keyed", "/key", "X-Api-Key: key-2"))
		}
		return err
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.tlsGuest(v, w.hp, trusting(w.icCA.pool))
		if err != nil {
			return err
		}
		defer g.close()
		if err := g.getOK("/x", w.hp, "Authorization: Bearer moca-placeholder", "X-Api-Key: moca-placeholder"); err != nil {
			return err
		}
		if err := wantAuth(w.up, "/x", "Bearer two-tok"); err != nil {
			return err
		}
		if err := wantHeader(w.up, "/x", "X-Api-Key", "key-1"); err != nil {
			return err
		}
		// A matched element that sets no Authorization: the guest's own must
		// not ride along next to the real credential (spec 5.2).
		// pinned against: dropping the Authorization delete on a match.
		if err := g.getOK("/key/y", w.hp, "Authorization: Bearer moca-placeholder", "X-Api-Key: guest"); err != nil {
			return err
		}
		if err := wantAuth(w.up, "/key/y", ""); err != nil {
			return err
		}
		return wantHeader(w.up, "/key/y", "X-Api-Key", "key-2")
	})
}

// credentialPortScoped: a credential for another port of the same host does
// not intercept a CONNECT to this one: it is an opaque tunnel (the guest
// handshakes with the upstream's own certificate) with nothing injected.
//
// pinned against: forPort returning the whole set (the CONNECT was
// intercepted: the guest's handshake against the upstream CA failed).
func credentialPortScoped(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			other := 8443
			if w.up.port() == other {
				other++
			}
			e := cred("other-port", "/", "Authorization: Bearer other-tok")
			e.Port = other
			w.give("sid-a", 60, e)
		}
		return err
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.tlsGuest(v, w.hp, trusting(w.upCA.pool))
		if err != nil {
			return err
		}
		defer g.close()
		if err := g.getOK("/x", w.hp); err != nil {
			return err
		}
		if err := wantAuth(w.up, "/x", ""); err != nil {
			return err
		}
		g.close() // a tunnel's event is written when it ends
		if _, err := h.wait(event{"decision": "tunnel", "method": "CONNECT", "host": upName}); err != nil {
			return err
		}
		if n := h.count(event{"decision": "credential_injected"}); n != 0 {
			return fmt.Errorf("%d credential_injected events for a port the credential does not cover", n)
		}
		return nil
	})
}

// traceRefusedOnInterceptedConn: TRACE and TRACK are refused with 405 inside
// an intercepted tunnel. An upstream that reflects the request would hand
// the injected credential back to the guest; the request is not sent at all.
//
// pinned against: removing the TRACE/TRACK refusal in icConn.next (the
// upstream, which reflects TRACE, returned the injected Authorization in the
// body).
func traceRefusedOnInterceptedConn(ctx context.Context, t Target) error {
	var w *icWorld
	return run(ctx, t, func(h *harness) (err error) {
		w, err = h.interceptWorld()
		if err == nil {
			w.give("sid-a", 60, cred("gh", "/", "Authorization: Bearer real-token-1"))
		}
		return err
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		for _, m := range []string{"TRACE", "TRACK"} {
			g, err := h.tlsGuest(v, w.hp, trusting(w.icCA.pool))
			if err != nil {
				return err
			}
			r, err := g.req(m, "/x", w.hp)
			g.close()
			if err != nil {
				return fmt.Errorf("%s: %w", m, err)
			}
			if r.status != 405 {
				return fmt.Errorf("%s: status %d (body %d bytes, Authorization line in body: %v), want 405",
					m, r.status, len(r.body), strings.Contains(strings.ToLower(r.body), "authorization:"))
			}
			if strings.Contains(r.body, "real-token-1") || strings.Contains(fmt.Sprint(r.header), "real-token-1") {
				return fmt.Errorf("%s: the response carries the credential", m)
			}
		}
		if n := len(w.up.requests()); n != 0 {
			return fmt.Errorf("%d TRACE/TRACK requests reached the upstream, want 0", n)
		}
		return nil
	})
}
