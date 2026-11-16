package egress

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"sync"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
)

// Resolver resolves a hostname. *net.Resolver satisfies it.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// Config configures a Proxy.
type Config struct {
	Allow       []AllowEntry
	PermitCIDRs []netip.Prefix

	MaxConnsPerVM, MaxRequestsPerSession int

	Resolver Resolver
	// LocalAddrs returns the host's own addresses, which are refused unless
	// permitted. nil means none. It is called per request; an error refuses.
	LocalAddrs func() ([]netip.Addr, error)

	Credentials CredentialPolicy
	// InterceptCACertPEM and InterceptCAKeyPEM are the loaded interception CA
	// (set by ConfigFromEnv when credentials are configured; Task 9 builds the
	// interceptor from them). UpstreamRoots verifies upstream servers; nil
	// means the system roots.
	InterceptCACertPEM, InterceptCAKeyPEM []byte
	UpstreamRoots                         *x509.CertPool
	// interceptor serves hosts that have credentials. nil is allowed only
	// while Credentials is NoCredentials.
	interceptor interceptor
	Audit       AuditSink

	DialTimeout time.Duration // default 10s
	// IdleTimeout bounds how long an established connection may go with no
	// bytes moving, in either direction and on either path. It is refreshed on
	// every read and every write, so a transfer of any duration survives; only
	// a silent one expires. Default 300s. Zero selects the default: a slot
	// unbounded in time is not an option a caller may choose.
	IdleTimeout time.Duration
	// ResponseHeaderTimeout bounds how long a forwarded request may wait for
	// its response headers after the request is sent. Separate from
	// IdleTimeout, and strictly tighter: it treats a silent upstream that has
	// been asked a question as a fault sooner than the idle bound would.
	//
	// It defaults to IdleTimeout rather than to something shorter, because
	// shorter is a policy call with a real cost and no safety benefit here. The
	// slot is already bounded without it — the idle clock covers the upstream
	// conn from the dial, so an upstream that never answers expires anyway —
	// while a tighter value turns legitimate slow thinking into a 502: a plain
	// HTTP inference endpoint can take minutes before its first header byte,
	// and so can a forge packing a large repo. An operator who would rather
	// fail fast sets MOCA_EGRESS_RESPONSE_HEADER_TIMEOUT_S below the idle
	// bound; nothing stops them, and no default guesses on their behalf.
	ResponseHeaderTimeout time.Duration
}

const (
	defaultDialTimeout = 10 * time.Second
	// defaultIdleTimeout matches squid's request_timeout. It has to outlast
	// the quiet stretch of a real upstream doing work — a large repo being
	// packed server-side before the first byte of the pack arrives, an
	// inference endpoint thinking — because it is refreshed per read, not per
	// request.
	defaultIdleTimeout = 300 * time.Second
	// defaultResponseHeaderTimeout is the idle bound: see the field's doc for
	// why this knob does not default tighter than the bound it refines.
	defaultResponseHeaderTimeout = defaultIdleTimeout
	// sessionIdle is how long a session counter survives without a request.
	sessionIdle = time.Hour
	// sweepEvery bounds how often the lazy session sweep runs.
	sweepEvery = time.Minute
)

// Proxy is the moca-egress forward proxy. Each registered VM has its own
// listener; the listener a connection arrives on is the caller's identity.
type Proxy struct {
	cfg   Config
	ident CallerIdentity
	now   func() time.Time

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu        sync.Mutex
	closed    bool
	vms       map[string]*vmBinding
	sessions  map[string]*sessionCount
	lastSweep time.Time
}

type vmBinding struct {
	caller Caller
	ln     net.Listener
	closed bool
	conns  map[*proxyConn]struct{}

	// capRefusals is the number of connection-cap refusals in flight for this
	// VM; capSuppressed and capLastEvent coalesce their audit events. All
	// three are guarded by Proxy.mu.
	capRefusals   int
	capSuppressed uint64
	capLastEvent  time.Time
}

type sessionCount struct {
	n    int
	last time.Time
}

var _ control.Handler = (*Proxy)(nil)

// NewProxy validates cfg and returns a Proxy with no VMs registered.
func NewProxy(cfg Config) (*Proxy, error) {
	switch {
	case len(cfg.Allow) == 0:
		return nil, errors.New("egress: empty allowlist")
	case cfg.Resolver == nil:
		return nil, errors.New("egress: nil Resolver")
	case cfg.Audit == nil:
		return nil, errors.New("egress: nil Audit")
	case cfg.Credentials == nil:
		return nil, errors.New("egress: nil Credentials")
	case cfg.interceptor == nil && !isNoCredentials(cfg.Credentials):
		return nil, errors.New("egress: a credential policy needs an interceptor")
	case cfg.MaxConnsPerVM <= 0:
		return nil, fmt.Errorf("egress: MaxConnsPerVM %d must be positive", cfg.MaxConnsPerVM)
	case cfg.MaxRequestsPerSession <= 0:
		return nil, fmt.Errorf("egress: MaxRequestsPerSession %d must be positive", cfg.MaxRequestsPerSession)
	case cfg.DialTimeout < 0:
		return nil, fmt.Errorf("egress: negative DialTimeout %v", cfg.DialTimeout)
	case cfg.IdleTimeout < 0:
		return nil, fmt.Errorf("egress: negative IdleTimeout %v", cfg.IdleTimeout)
	case cfg.ResponseHeaderTimeout < 0:
		return nil, fmt.Errorf("egress: negative ResponseHeaderTimeout %v", cfg.ResponseHeaderTimeout)
	}
	if cfg.DialTimeout == 0 {
		cfg.DialTimeout = defaultDialTimeout
	}
	if cfg.IdleTimeout == 0 {
		cfg.IdleTimeout = defaultIdleTimeout
	}
	if cfg.ResponseHeaderTimeout == 0 {
		// The effective idle bound, not defaultIdleTimeout: an operator who
		// raises only the idle bound must not be left with a tighter header
		// timeout hiding behind it.
		cfg.ResponseHeaderTimeout = cfg.IdleTimeout
	}
	cfg.Allow = append([]AllowEntry(nil), cfg.Allow...)
	cfg.PermitCIDRs = append([]netip.Prefix(nil), cfg.PermitCIDRs...)
	ctx, cancel := context.WithCancel(context.Background())
	return &Proxy{
		cfg: cfg, ident: socketIdentity{}, now: time.Now,
		ctx: ctx, cancel: cancel,
		vms: map[string]*vmBinding{}, sessions: map[string]*sessionCount{},
	}, nil
}

// Register binds vmID to sessionID and starts serving ln. On a nil return the
// proxy owns ln. A non-empty grant is refused: this slice has no grants.
func (p *Proxy) Register(vmID, sessionID string, grant []byte, ln net.Listener) error {
	if len(grant) != 0 {
		return &control.RefusalError{Code: control.CodeBadRequest, Message: "grants are not supported in this slice (MI1 S2)"}
	}
	if vmID == "" || sessionID == "" || ln == nil {
		return &control.RefusalError{Code: control.CodeBadRequest, Message: "vm_id, session_id and listener are required"}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return errors.New("egress: proxy closed")
	}
	if _, ok := p.vms[vmID]; ok {
		return &control.RefusalError{Code: control.CodeDuplicateVM, Message: vmID}
	}
	b := &vmBinding{caller: Caller{VMID: vmID, SessionID: sessionID}, ln: ln, conns: map[*proxyConn]struct{}{}}
	p.vms[vmID] = b
	p.wg.Add(1)
	go p.serve(b)
	return nil
}

// Unregister closes vmID's listener and every live connection of vmID. Each
// connection still live is recorded as one aborted event. An unknown vmID is
// not an error.
func (p *Proxy) Unregister(vmID string) error {
	p.mu.Lock()
	b, ok := p.vms[vmID]
	if !ok {
		p.mu.Unlock()
		return nil
	}
	delete(p.vms, vmID)
	b.closed = true
	conns := make([]*proxyConn, 0, len(b.conns))
	for pc := range b.conns {
		conns = append(conns, pc)
	}
	p.mu.Unlock()
	err := b.ln.Close()
	for _, pc := range conns {
		pc.abort()
	}
	if errors.Is(err, net.ErrClosed) {
		err = nil
	}
	return err
}

// Close unregisters every VM and waits for all goroutines to finish.
func (p *Proxy) Close() error {
	p.mu.Lock()
	p.closed = true
	ids := make([]string, 0, len(p.vms))
	for id := range p.vms {
		ids = append(ids, id)
	}
	p.mu.Unlock()
	var errs []error
	for _, id := range ids {
		errs = append(errs, p.Unregister(id))
	}
	p.cancel()
	p.wg.Wait()
	return errors.Join(errs...)
}

// serve accepts on b.ln until it is closed. Transient accept errors back off
// (5 ms doubling to 1 s), as the guest forwarder does.
func (p *Proxy) serve(b *vmBinding) {
	defer p.wg.Done()
	var delay time.Duration
	for {
		c, err := b.ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || p.ctx.Err() != nil || p.bindingClosed(b) {
				return
			}
			if delay == 0 {
				delay = 5 * time.Millisecond
			} else if delay *= 2; delay > time.Second {
				delay = time.Second
			}
			log.Printf("moca-egress: accept vm %s: %v; retrying in %v", b.caller.VMID, err, delay)
			time.Sleep(delay)
			continue
		}
		delay = 0
		p.admit(b, &boundConn{Conn: c, caller: b.caller})
	}
}

func (p *Proxy) bindingClosed(b *vmBinding) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return b.closed
}

// admit applies the per-VM connection cap and starts the handler.
func (p *Proxy) admit(b *vmBinding, c *boundConn) {
	caller, ok := p.ident.Identify(c)
	if !ok {
		// Unreachable: every accepted conn is bound. Fail closed regardless.
		p.cfg.Audit.Emit(Event{Decision: DecisionNoBinding, Status: 403})
		_ = c.Close()
		return
	}
	p.mu.Lock()
	if b.closed {
		p.mu.Unlock()
		_ = c.Close()
		return
	}
	if len(b.conns) >= p.cfg.MaxConnsPerVM {
		// Both decisions are taken under p.mu, which this branch already holds:
		// whether to spend a refusal socket, and whether this refusal is the
		// one that reports the interval. A guest in a tight loop must not be
		// able to grow either fds or audit volume without bound.
		drain := b.capRefusals < maxCapRefusalsPerVM
		if drain {
			b.capRefusals++
			p.wg.Add(1)
		}
		ev, report := b.chargeCapRefusal(p.now())
		p.mu.Unlock()
		if report {
			ev.VMID, ev.SID, ev.Sub = caller.VMID, caller.SessionID, caller.Subject
			p.cfg.Audit.Emit(ev)
		}
		if !drain {
			// Past the bound the 429 is not written at all: shedding the fd
			// matters more than the guest reading its refusal.
			_ = c.Close()
			return
		}
		go func() {
			defer p.wg.Done()
			defer func() {
				p.mu.Lock()
				b.capRefusals--
				p.mu.Unlock()
			}()
			// Not parsed: the cap exists to shed load. The bounded drain, as
			// for every refusal, lets a guest that pipelined its request see
			// the named 429 rather than a reset.
			writeAndClose(c, refusalBytes(429, DecisionConnCap, caller.VMID))
		}()
		return
	}
	ctx, cancel := context.WithCancel(p.ctx)
	pc := &proxyConn{p: p, c: c, caller: caller, ctx: ctx, cancel: cancel}
	b.conns[pc] = struct{}{}
	p.wg.Add(1)
	p.mu.Unlock()
	go func() {
		defer p.wg.Done()
		defer func() {
			p.mu.Lock()
			delete(b.conns, pc)
			p.mu.Unlock()
		}()
		pc.serve()
	}()
}

// chargeCapRefusal charges one connection-cap refusal to b and reports the
// event to emit, if any. The first refusal in an interval is reported, and
// carries however many were suppressed since the last report; the rest are
// only counted. Caller holds Proxy.mu.
func (b *vmBinding) chargeCapRefusal(now time.Time) (Event, bool) {
	if !b.capLastEvent.IsZero() && now.Sub(b.capLastEvent) < capEventEvery {
		b.capSuppressed++
		return Event{}, false
	}
	b.capLastEvent = now
	n := b.capSuppressed
	b.capSuppressed = 0
	return Event{Status: 429, Decision: DecisionConnCap, Coalesced: n}, true
}

// countRequest charges one request to sid and reports whether it is within
// the cap. Counters idle for over an hour are swept lazily, but never while a
// VM of that session is still registered: the cap is a hard per-session cap.
func (p *Proxy) countRequest(sid string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	if now.Sub(p.lastSweep) >= sweepEvery {
		p.lastSweep = now
		bound := map[string]bool{}
		for _, b := range p.vms {
			bound[b.caller.SessionID] = true
		}
		for s, c := range p.sessions {
			if !bound[s] && now.Sub(c.last) > sessionIdle {
				delete(p.sessions, s)
			}
		}
	}
	c := p.sessions[sid]
	if c == nil {
		c = &sessionCount{}
		p.sessions[sid] = c
	}
	c.last = now
	if c.n < p.cfg.MaxRequestsPerSession {
		c.n++
		return true
	}
	return false
}

// proxyConn is one live guest connection. Exactly one terminal event is
// emitted for it: its own (tunnel, a refusal) or, if Unregister wins, aborted.
type proxyConn struct {
	p      *Proxy
	c      *boundConn
	caller Caller
	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	done    bool
	aborted bool
	up      net.Conn
	host    string
	method  string
}

func (pc *proxyConn) event(e Event) Event {
	e.VMID, e.SID = pc.caller.VMID, pc.caller.SessionID
	if e.Sub == "" { // an intercepted request carries the credential owner from the lookup
		e.Sub = pc.caller.Subject
	}
	return e
}

// emit records e unless the conn was aborted or already terminated. A
// terminal event ends the conn's audit trail.
func (pc *proxyConn) emit(e Event, terminal bool) {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	if pc.aborted || pc.done {
		return
	}
	if terminal {
		pc.done = true
	}
	pc.p.cfg.Audit.Emit(pc.event(e))
}

// wasAborted reports whether Unregister aborted the conn. abort sets it before
// it cancels the conn's context, so a request that failed because of that
// cancel always sees it set.
func (pc *proxyConn) wasAborted() bool {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	return pc.aborted
}

// setTarget records the request being served, for an aborted event.
func (pc *proxyConn) setTarget(method, host string) {
	pc.mu.Lock()
	pc.method, pc.host = method, host
	pc.mu.Unlock()
}

// setUpstream records the dialled upstream so that abort can close it. It
// reports false, and the caller must close up, if the conn was aborted.
func (pc *proxyConn) setUpstream(up net.Conn) bool {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	if pc.aborted {
		return false
	}
	pc.up = up
	return true
}

func (pc *proxyConn) abort() {
	pc.mu.Lock()
	if !pc.aborted && !pc.done {
		pc.p.cfg.Audit.Emit(pc.event(Event{Host: pc.host, Method: pc.method, Decision: DecisionAborted}))
	}
	pc.aborted = true
	up := pc.up
	pc.mu.Unlock()
	pc.cancel()
	_ = pc.c.Close()
	if up != nil {
		_ = up.Close()
	}
}

// finish marks a normal end without an event and releases resources.
func (pc *proxyConn) finish() {
	pc.mu.Lock()
	pc.done = true
	up := pc.up
	pc.mu.Unlock()
	pc.cancel()
	_ = pc.c.Close()
	if up != nil {
		_ = up.Close()
	}
}

func isNoCredentials(p CredentialPolicy) bool {
	_, ok := p.(NoCredentials)
	return ok
}
