package session

import (
	"context"
	"errors"
	"fmt"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/rossoctl/moca/gen/go/sandbox/v1"
	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

const (
	// QueueCap bounds queued execs. Overflow is refused rather than blocking the
	// recv loop — see Serve. It also bounds how many chunk-class frames may sit in
	// outbound at once, which is what leaves the reserve below reachable.
	QueueCap = 64
	// TerminalReserve is outbound capacity that ONLY the recv goroutine may use, for
	// the terminal frames it must not drop (#173 item 1). Chunk producers are held
	// to QueueCap residency, so these slots are always free for a refusal.
	//
	// It cannot be a proof, and is not sized as if it were: accept emits one
	// terminal frame per refused exec and nothing bounds how many arrive between two
	// drains, so a large enough burst still exhausts it. What the reserve buys is
	// that a transient chunk backlog — the common case, and the one that produced
	// the bug — can no longer squeeze a refusal out. Exhaustion is then a genuinely
	// different condition (nothing is draining at all) and is handled as one, by
	// failing the connection rather than losing the frame. Deliberately modest for
	// that reason: a big reserve would only buffer more frames behind a wedged
	// sender before anyone noticed.
	// Derived from QueueCap, so it degrades badly if QueueCap is ever lowered: at
	// QueueCap < 4 this is 0, the reserve vanishes, and trySend then fails on any
	// full buffer — turning a transient chunk backlog into a dropped connection,
	// which is a WORSE failure than the dropped frame this all exists to prevent.
	// The assertion below the const block makes that a compile error instead.
	TerminalReserve = QueueCap / 4
	// DeferredCap bounds terminal frames waiting behind a full reserve (#705). A burst of
	// refusals larger than TerminalReserve is no longer a reason to end the connection: the
	// overflow waits here, in order, and a drainer feeds it into the reserve as the sender
	// frees it. This cap is only the backstop for a sender that is genuinely not keeping up;
	// each entry is one small frame, and the relay would have to send this many Execs past the
	// admission limit (MaxConcurrent + QueueCap) faster than they can be refused.
	DeferredCap = 4096
	// DefaultWedgeAfter is how long one Send may stay blocked, with terminal frames waiting,
	// before the session calls egress wedged (Config.WedgeAfter). Two heartbeats: a sender that
	// cannot place even a heartbeat in that time is not slow, it is stuck.
	DefaultWedgeAfter = 2 * DefaultHeartbeat
	// DefaultConcurrency is the pool size, advertised as Hello.capacity_max.
	DefaultConcurrency = 4
	// DefaultHeartbeat is liveness plus NAT/proxy keepalive (spec §7 item 4).
	DefaultHeartbeat = 15 * time.Second
)

// TerminalReserve must be at least 1, or the reserve silently disappears and every
// full buffer becomes a dropped connection. A negative array length is a compile
// error, so this fails at build time rather than in production. Same intent as
// outFrame carrying its own accounting: make the next maintainer's plausible
// mistake impossible rather than merely documented.
var _ [TerminalReserve - 1]struct{}

// Config is everything the session needs that does not come off the wire.
type Config struct {
	SandboxID     string
	Image         string
	Trust         string
	Capabilities  []string
	MaxConcurrent int
	Heartbeat     time.Duration
	// Labels go into Hello.labels verbatim; the relay mirrors them into the presence record.
	// Labels builds the two the harness reads (moca.dev/tier, moca.dev/template).
	Labels map[string]string
	// WedgeAfter is how long one Send may stay blocked while terminal frames wait behind the
	// reserve before the connection is given up as wedged (#705). Zero means
	// DefaultWedgeAfter.
	WedgeAfter time.Duration
}

// ErrEgressWedged ends a session whose terminal frames cannot be delivered: the
// sender has been blocked in one Send for Config.WedgeAfter while terminal frames
// wait, or DeferredCap of them are waiting at once (#705). It is not "busy": a
// burst of refusals that merely outruns the sender is deferred, in order, and
// delivered; only a sender that is not draining at all ends the connection. Serve returns it so main.go
// re-dials; the dedup cache then answers redeliveries of anything that completed
// (spec §5, §6.2). The alternative was to log the loss and keep serving a
// connection whose callers each wait out DEFAULT_EXEC_TIMEOUT_S, 30 minutes since
// #182 (#173 item 1).
var ErrEgressWedged = errors.New("egress wedged: the terminal-frame reserve could not be queued")

// outFrame is a frame plus the accounting it was admitted under. reserved frames
// came through the terminal reserve and hold no chunkSlot, so the sender must not
// release one when it forwards them — hence carrying the fact explicitly rather
// than re-deriving it from the frame's type. Deriving it would silently break the
// accounting the day a frame kind is sent from both paths.
type outFrame struct {
	frame    *pb.WorkerFrame
	reserved bool
}

// Stream is one Attach connection. pb.SandboxWorker_AttachClient satisfies it
// directly, so production needs no adapter.
type Stream interface {
	Send(*pb.WorkerFrame) error
	Recv() (*pb.ServerFrame, error)
}

// Session holds state that must outlive any single connection — above all the
// dedup cache, so a reconnect does not forget what already ran (spec §5).
type Session struct {
	cfg    Config
	runner wexec.Runner
	cache  *Cache
	// inflight counts admitted Execs whose terminal frame has not been sent, across every
	// connection, so main.go can rotate its attach token at an idle moment (Idle).
	inflight atomic.Int64
	// unsent counts frames put on a connection's outbound queue that its sender has not yet
	// handed to Send. An Exec's terminal frame is queued before inflight drops, so Idle reads
	// inflight first and then this: a terminal frame still behind chunks keeps the session busy.
	unsent atomic.Int64
	// leaseSlots holds one token per mutating LeaseControl call running, across every
	// connection, and leaseByKey counts them per workspace key (under leaseMu): see
	// leaseControlCap and takeLeaseSlot. leaseStatusSlots holds one per status call running
	// (leaseStatusCap), apart from them, so neither kind can deny the other.
	leaseSlots       chan struct{}
	leaseStatusSlots chan struct{}
	leaseMu          sync.Mutex
	leaseByKey       map[string]int

	// Counters for Stats (#705), across every connection.
	queueFullRefusals atomic.Uint64
	deferredFrames    atomic.Uint64
	deferredNow       atomic.Int64
	wedgedConns       atomic.Uint64
	// refusalLog rate-limits the "busy: queue full" log line (see logRefusal).
	refusalLog struct {
		mu         sync.Mutex
		last       time.Time
		suppressed int
	}
}

// Stats are the session's own counters, for the worker's diagnostics (/stats).
type Stats struct {
	// QueueFullRefusals counts Execs refused "busy: queue full": each arrived while
	// MaxConcurrent were running and QueueCap were queued on its connection.
	QueueFullRefusals uint64
	// DeferredFrames counts terminal frames (refusals, replays) that found the reserve full
	// and waited behind it instead of ending the connection; DeferredNow is how many wait now.
	DeferredFrames uint64
	DeferredNow    int64
	// WedgedConnections counts connections ended because egress was wedged.
	WedgedConnections uint64
}

// Stats reads the counters. Safe for concurrent use.
func (s *Session) Stats() Stats {
	return Stats{
		QueueFullRefusals: s.queueFullRefusals.Load(),
		DeferredFrames:    s.deferredFrames.Load(),
		DeferredNow:       s.deferredNow.Load(),
		WedgedConnections: s.wedgedConns.Load(),
	}
}

// logRefusal logs a "busy: queue full" refusal, at most one line a second, naming how many
// were folded into it. Before #705 a refusal left no trace in the worker log at all, so the
// per-connection admission limit (MaxConcurrent + QueueCap) stayed invisible until
// something else broke.
func (s *Session) logRefusal(reqID uint64, queued int) {
	s.queueFullRefusals.Add(1)
	rl := &s.refusalLog
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if now := time.Now(); now.Sub(rl.last) >= time.Second {
		log.Printf("session: refused req_id %d: busy: queue full (%d running, %d of %d queued on this "+
			"connection; %d more refused since the last line; %d in total)", reqID, s.cfg.MaxConcurrent,
			queued, QueueCap, rl.suppressed, s.queueFullRefusals.Load())
		rl.last, rl.suppressed = now, 0
		return
	}
	rl.suppressed++
}

// Idle reports that no admitted Exec is queued or running, and that every frame queued for the
// relay -- an Exec's terminal frame above all -- has been sent. main.go reconnects with a rotated
// token file only then (workload sandboxes spec §3.1), so a rotation cuts no Exec short. An Exec
// that arrives between this check and the reconnect fails with "worker disconnected", as any
// reconnect's would.
func (s *Session) Idle() bool {
	// This order, not the reverse: see unsent.
	return s.inflight.Load() == 0 && s.unsent.Load() == 0
}

func New(cfg Config, r wexec.Runner) *Session {
	if cfg.MaxConcurrent <= 0 {
		cfg.MaxConcurrent = DefaultConcurrency
	}
	if cfg.Heartbeat <= 0 {
		cfg.Heartbeat = DefaultHeartbeat
	}
	return &Session{
		cfg: cfg, runner: r, cache: NewCache(CacheSize),
		leaseSlots:       make(chan struct{}, leaseControlCap),
		leaseStatusSlots: make(chan struct{}, leaseStatusCap),
		leaseByKey:       map[string]int{},
	}
}

// slot tracks one accepted exec so an Abort can reach it whether it is running
// or still queued.
type slot struct {
	ctx    context.Context
	cancel context.CancelFunc
	// fp fingerprints the exec occupying this slot. accept needs it to tell a
	// genuine redelivery of THIS exec (the same Exec by Fingerprint, terminal frame
	// already owed) from a req_id collision carrying different work under the same id
	// (spec §3.1) — the two demand opposite handling.
	fp [32]byte
}

// execRegistry owns the in-flight slot map and the ONE mutex that guards it, so
// this file's central safety property — every access to the slot map happens under
// the mutex — is checkable by reading one type instead of six scattered call sites
// (#173 item 4). Previously the raw *sync.Mutex was threaded through recvLoop and
// accept as a positional parameter alongside the map, which made "did this caller
// take the lock?" a question you answered by reading, every time, in five places.
//
// BE PRECISE ABOUT WHAT THIS GUARANTEES. execRegistry lives in the same package as
// its callers, so unexported fields are no barrier: nothing stops future code here
// from writing r.inflight[id] directly, and the compiler will not object. What the
// type buys is that every access is now co-located in the ~60 lines below and there
// is no longer a map-and-mutex pair being passed around inviting ad-hoc use. That
// is an auditability win, not an enforcement one. Making it enforced would mean a
// separate package, which would in turn require exporting slot and its fields —
// more surface than a single file's invariant is worth.
//
// Every method below corresponds to exactly one critical section that used to be
// written out longhand, and each preserves its original lock SCOPE — notably which
// side of the unlock the cancel happens on, which differs between finish and remove
// and is not incidental.
type execRegistry struct {
	mu       sync.Mutex
	inflight map[uint64]*slot
}

func newExecRegistry() *execRegistry {
	return &execRegistry{inflight: map[uint64]*slot{}}
}

// abort cancels an exec but deliberately LEAVES it in the map. A queued exec must
// still be dequeued so runOne can emit its terminal frame; deleting here would make
// the pool skip it (sl == nil) and the harness would wait for a frame that never
// arrives.
func (r *execRegistry) abort(reqID uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if sl, ok := r.inflight[reqID]; ok {
		sl.cancel()
	}
}

// finish releases the slot once its terminal frame has been sent. The cancel happens
// under the lock here, unlike remove: this is the terminal release, so there is no
// caller left holding the CancelFunc to call it afterwards.
func (r *execRegistry) finish(reqID uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if sl, ok := r.inflight[reqID]; ok {
		sl.cancel()
		delete(r.inflight, reqID)
	}
}

// remove deletes a slot WITHOUT cancelling it, for accept's queue-full branch: that
// caller still holds the CancelFunc and cancels outside the lock, which is the scope
// the code had before this refactor. Keeping the two apart is deliberate — widening
// finish's behaviour to cover this case would move a cancel inside the lock.
func (r *execRegistry) remove(reqID uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.inflight, reqID)
}

// slotFor returns the slot occupying reqID, or nil. The result is safe to use after
// the lock is dropped: a slot's fields are never mutated after insertion, and cancel
// is safe to call concurrently.
func (r *execRegistry) slotFor(reqID uint64) *slot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.inflight[reqID]
}

// claim performs accept's whole admission decision under ONE hold of the lock, and
// exists because that decision is compound: it reads the slot map, then may consult
// the dedup cache, then may insert — and those three must not interleave with
// another accept or a finish. decide receives the slot currently in flight for reqID
// (nil if none) and returns its verdict plus the slot to insert, or nil to insert
// nothing.
//
// The outcome is RETURNED rather than written back through a captured variable, and
// that is a safety property, not a style choice. claimAdmitted is iota's zero value
// and admitting is accept's fall-through case, so a captured outcome makes "decide
// decided to admit" and "decide never ran" the same state. Returning it means a
// caller cannot observe an outcome that was never decided: today claim always calls
// decide, but if it ever gained an early return, the failure would be the silent one
// this file works hardest to prevent — an exec enqueued with no slot, skipped by the
// pool at sl == nil, and never given a terminal frame, leaving the caller to wait out
// DEFAULT_EXEC_TIMEOUT_S (30 minutes since #182).
//
// decide must DECIDE ONLY. Side effects — cancel, trySend, logging — belong after
// claim returns, because the pre-refactor code released the mutex before every one
// of them and holding it across a channel send or a log write would widen the
// critical section rather than merely relocate it.
func (r *execRegistry) claim(reqID uint64, decide func(running *slot) (claimOutcome, *slot)) claimOutcome {
	r.mu.Lock()
	defer r.mu.Unlock()
	outcome, sl := decide(r.inflight[reqID])
	if sl != nil {
		r.inflight[reqID] = sl
	}
	return outcome
}

// claimOutcome is what accept's admission decision resolved to. It exists so the
// decision can be taken under the registry lock and ACTED ON after it is dropped:
// three of the four outcomes send a frame or write a log line, neither of which
// belongs inside the critical section.
type claimOutcome int

const (
	// claimAdmitted: a fresh exec; a slot was inserted and the caller enqueues it.
	claimAdmitted claimOutcome = iota
	// claimCoalesced: a genuine redelivery of a still-running exec — say nothing on
	// the wire, its terminal frame is already owed.
	claimCoalesced
	// claimCollision: a DIFFERENT command under a req_id already in flight; refuse it.
	claimCollision
	// claimCacheHit: a redelivery of a completed exec; replay the cached frame.
	claimCacheHit
)

// conn bundles the per-connection plumbing recvLoop and accept need. It replaces
// seven and six positional parameters respectively, of which one was the raw mutex
// execRegistry now hides. Nothing here is owned by Session: a Session outlives many
// conns (the cache is what survives a re-dial), so this state is per-Serve.
type conn struct {
	st      Stream
	trySend func(*pb.WorkerFrame) bool
	// sendLate is the blocking enqueue for a producer Serve does NOT wait for (a LeaseControl
	// goroutine). It reports false, and queues nothing, once the connection has ended.
	sendLate func(*pb.WorkerFrame) bool
	queue    chan *pb.Exec
	reg      *execRegistry
}

// lateGate lets a goroutine that Serve does not wait for enqueue safely. Serve closes
// outbound once its own producers are done; a send on a closed channel panics, even inside a
// select. Holders of the read lock may enqueue; Serve takes the write lock, after cancelling
// the connection (so a held enqueue returns promptly), and marks the gate shut before it
// closes outbound.
type lateGate struct {
	mu     sync.RWMutex
	closed bool
}

func (g *lateGate) send(enqueue func(*pb.WorkerFrame) bool, f *pb.WorkerFrame) bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.closed {
		return false
	}
	return enqueue(f)
}

func (g *lateGate) shut() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
}

// Serve runs one connection to exhaustion and returns why it ended. The caller
// re-dials and calls Serve again; the cache survives because it lives on Session.
//
// One dedicated sender goroutine owns st.Send: no mutex serializes it, because
// gRPC-Go's SendMsg blocks on flow control, and if any producer held a lock
// across that call while ALSO trying to refuse work inline (the old design),
// the recv goroutine could stall behind its own refusal frame with an Abort
// queued right behind it in the stream — deadlock, since that Abort is what
// would free the pool that is saturating the send window. Routing every frame
// through a channel instead makes "send" a non-blocking enqueue for the recv
// goroutine and a bounded-blocking enqueue (correct backpressure) for everyone
// else.
//
// A non-blocking enqueue can only fail by DROPPING, though, and everything the
// recv goroutine sends is terminal — which is how a refusal used to vanish and
// leave its caller waiting out a 30-minute deadline (#173 item 1). So the single
// channel carries TerminalReserve slots that chunk producers cannot reach: see
// chunkSlots and trySend below. One channel, not two, because ordering is a wire
// contract (spec §8) and a priority lane would break it.
//
// PRECONDITION on ctx: it MUST be the context the Attach stream was created from
// (in production, the same attachCtx handed to client.Attach). recvLoop blocks in
// st.Recv() and has NO select on ctx, so cancelling ctx does not by itself stop
// Serve: the only thing that ever unblocks the receive is gRPC tearing the stream
// down, which happens when the STREAM's context is cancelled. The requirement is
// on the STREAM's context, not on the ctx argument itself: as long as the stream
// was created from a context that does get cancelled, handing Serve a different,
// unrelated ctx is harmless and shutdown still works. What actually wedges is
// creating the stream from a context nothing ever cancels — then Serve hangs in
// Recv until the connection happens to die on its own, no matter what ctx it was
// given. It compiles, it vets, and it passes every test that ends a session by
// closing the stream instead of cancelling. Do not "clean that up".
//
// Serve does not tear the stream down when it returns on its own (ErrEgressWedged): the caller
// cancels the stream's context before re-dialling, or the relay refuses the re-dial (#839).
func (s *Session) Serve(ctx context.Context, st Stream) error {
	connCtx, cancelConn := context.WithCancel(ctx)
	// Cancelling the connection context kills every in-flight child: their output
	// has nowhere to go, and the relay has already failed them harness-side
	// (relay.ts:89-93), so leaving them running only orphans work (spec §6.2).
	defer cancelConn()

	// Hello goes out directly, before any goroutine exists. No concurrency yet,
	// so there is nothing to race and no need for the outbound channel just to
	// guarantee it is first.
	if err := st.Send(&pb.WorkerFrame{Msg: &pb.WorkerFrame_Hello{Hello: &pb.Hello{
		SandboxId:    s.cfg.SandboxID,
		Labels:       s.cfg.Labels,
		Capabilities: s.cfg.Capabilities,
		Image:        s.cfg.Image,
		Arch:         runtime.GOARCH,
		CapacityMax:  uint32(s.cfg.MaxConcurrent),
		Trust:        s.cfg.Trust,
	}}}); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	// ONE channel carries every frame, and that is load-bearing rather than
	// incidental: spec §8 requires Chunk* then End per req_id, so a second
	// "priority" channel for terminal frames would let a cache-hit replay overtake
	// the original's still-queued chunks, or a colliding refusal overtake an earlier
	// exec's frames under the same id. The harness would settle the exec on the
	// frame that arrived first and discard the real output behind it. Ordering is
	// therefore kept by construction, and the starvation problem (#173 item 1) is
	// solved with RESERVED CAPACITY instead of with priority.
	outbound := make(chan outFrame, QueueCap+TerminalReserve)
	// chunkSlots caps how many chunk-class frames may be RESIDENT in outbound at
	// once. Whatever the chunk stream does, TerminalReserve slots stay free for the
	// terminal frames accept must not drop.
	chunkSlots := make(chan struct{}, QueueCap)
	// sendingSince is when the Send in progress began (UnixNano), 0 between Sends. It is what
	// tells a sender that is behind from one that is stuck (#705): time since the LAST Send
	// would call a burst after an idle hour wedged at once.
	var sendingSince atomic.Int64
	wedgeAfter := s.cfg.WedgeAfter
	if wedgeAfter <= 0 {
		wedgeAfter = DefaultWedgeAfter
	}
	var wgSender sync.WaitGroup
	wgSender.Add(1)
	go func() {
		defer wgSender.Done()
		failed := false
		for of := range outbound {
			if !of.reserved {
				// Release the instant the frame LEAVES the channel, before Send rather
				// than after. The semaphore counts residency in the channel, so a frame
				// held in this goroutine's hand must not keep a slot — otherwise a
				// blocked Send would shrink the effective chunk budget by one and, worse,
				// make the reserve arithmetic depend on Send's latency.
				<-chunkSlots
			}
			if failed {
				// Keep draining rather than returning: if this goroutine exited early,
				// every later blocking enqueue below would block forever once the
				// buffer filled, and wg.Wait() in Serve would never reach zero.
				s.unsent.Add(-1)
				continue
			}
			sendingSince.Store(time.Now().UnixNano())
			err := st.Send(of.frame)
			sendingSince.Store(0)
			if err != nil {
				failed = true
				cancelConn()
			}
			s.unsent.Add(-1)
		}
	}()

	// enqueue is the blocking sender used by producers (heartbeat, the pool). It reports
	// whether the frame was queued: false only when connCtx ended first.
	// Backpressure here is correct: neither is the recv goroutine, so blocking
	// them cannot stall a read of an Abort frame.
	//
	// Both waits give up if connCtx is done, and that is not defensive garnish. A
	// Send that BLOCKS forever (rather than failing) parks the sender, outbound
	// fills, and a producer waiting here would never return — so wg.Wait() in
	// Serve's teardown would never reach zero and Serve could never return, which
	// is the only thing that makes main.go re-dial. That hazard predates the
	// reserve; the semaphore just adds a second place to hit it. Frames abandoned
	// this way are not silently lost work: the connection is already dying, the
	// harness re-dials, and the dedup cache answers the redelivery (spec §5, §6.2).
	enqueue := func(f *pb.WorkerFrame) bool {
		// Non-blocking attempts first, so behaviour is unchanged whenever there is
		// room. select picks at random among ready cases, so without these a done
		// connCtx could abandon a frame that would have fit.
		select {
		case chunkSlots <- struct{}{}:
		default:
			select {
			case chunkSlots <- struct{}{}:
			case <-connCtx.Done():
				return false
			}
		}
		// A held slot does NOT guarantee room here, so this wait is real rather than
		// belt-and-braces: reserved frames are bounded only by the channel's own
		// capacity, so a burst of refusals can fill outbound while chunk-class
		// residency is low, and a producer holding a slot then finds the channel
		// full. That starves chunk producers in favour of terminal frames, which is
		// the intended priority — producers are exactly the ones allowed to block.
		// Counted before it is queued, so the sender's decrement can never come first.
		s.unsent.Add(1)
		select {
		case outbound <- outFrame{frame: f}:
			return true
		default:
		}
		select {
		case outbound <- outFrame{frame: f}:
			return true
		case <-connCtx.Done():
			s.unsent.Add(-1)
			<-chunkSlots // hand the slot back; nothing will ever drain this frame
			return false
		}
	}
	// trySend is the non-blocking sender used by the recv goroutine (via accept).
	// It must never block: the recv goroutine has to stay free to read the next
	// Abort, so it cannot wait for room.
	//
	// Every frame accept routes through here is TERMINAL: a cache-hit replay, or a
	// refusal ("busy: queue full", or a req_id collision). Dropping a replay would
	// only lose a duplicate of a frame already delivered once, but dropping a
	// refusal loses it outright, since refusals are never cached — and the drop
	// correlated with the exact overload that produced it, so the caller got
	// nothing and waited out its own deadline. #182 made that deadline
	// DEFAULT_EXEC_TIMEOUT_S = 30 minutes, which is what retired the old comment's
	// "survivable because the harness timeout is dual-ended".
	//
	// It no longer competes with the chunk stream for room: chunkSlots holds
	// chunk-class residency to QueueCap, so the last TerminalReserve slots are
	// reachable only from here. And a full reserve no longer ends the connection
	// (#705): nothing bounds how many refusals arrive between two drains, so a burst
	// of them (many sessions ending at once, a mass cancel) used to overflow the 16
	// slots and drop the connection, failing every unrelated Exec running on it. The
	// overflow now waits in `deferred`, in arrival order, and drainDeferred feeds it
	// into the reserve as the sender frees it. While anything waits there, later
	// terminal frames queue behind it rather than taking a freed slot, so none
	// overtakes another; a deferred frame only ever moves LATER, which spec §8's
	// ordering allows (a refused exec has no chunks of its own to stay behind).
	//
	// What still ends the connection is a sender that is not draining at all: one Send
	// blocked for wedgeAfter while frames wait, or DeferredCap of them waiting at once.
	// That is ErrEgressWedged, as before, and main.go re-dials.
	deferred := &deferQueue{wake: make(chan struct{}, 1)}
	trySend := func(f *pb.WorkerFrame) bool {
		return s.offerTerminal(deferred, outbound, &sendingSince, wedgeAfter, f)
	}

	var wg sync.WaitGroup // producers: heartbeat + pool workers
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(s.cfg.Heartbeat)
		defer t.Stop()
		for {
			select {
			case <-connCtx.Done():
				return
			case <-t.C:
				enqueue(&pb.WorkerFrame{Msg: &pb.WorkerFrame_Heartbeat{Heartbeat: &pb.Heartbeat{}}})
			}
		}
	}()

	// The deferred terminal frames' drainer (#705). A producer like the pool: it may block on
	// outbound, and it is joined by wg before outbound closes.
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.drainDeferred(connCtx, deferred, outbound)
	}()

	gate := &lateGate{}
	c := &conn{
		st:       st,
		trySend:  trySend,
		sendLate: func(f *pb.WorkerFrame) bool { return gate.send(enqueue, f) },
		queue:    make(chan *pb.Exec, QueueCap),
		reg:      newExecRegistry(),
	}

	for i := 0; i < s.cfg.MaxConcurrent; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for e := range c.queue {
				sl := c.reg.slotFor(e.GetReqId())
				if sl == nil {
					// Defensive only: the sole path that removes a slot before dequeue
					// is accept's queue-full branch, and that branch never enqueues.
					s.inflight.Add(-1)
					continue
				}
				s.runOne(sl.ctx, connCtx.Done(), enqueue, e)
				c.reg.finish(e.GetReqId())
				s.inflight.Add(-1)
			}
		}()
	}

	recvErr := s.recvLoop(connCtx, c)

	// Cancel BEFORE closing the queue: a still-queued exec must see a done ctx
	// once dequeued, so runOne takes its "aborted while queued" branch instead of
	// spawning a real bash child only to kill it immediately.
	cancelConn() // stop heartbeats and kill in-flight/queued children
	close(c.queue)
	wg.Wait()   // producers done: no more enqueues to outbound from them
	gate.shut() // nor from a LeaseControl goroutine still running
	close(outbound)
	wgSender.Wait()
	return recvErr
}

// recvLoop reads server frames until the stream fails. It must NEVER block: if
// dispatch blocked on a full queue — or on sending a refusal frame — an Abort
// queued behind it could never be read, and that abort is what would free the
// pool (spec §6.2). Every send accept makes goes through trySend accordingly.
func (s *Session) recvLoop(ctx context.Context, c *conn) error {
	for {
		sf, err := c.st.Recv()
		if err != nil {
			return err
		}
		switch m := sf.Msg.(type) {
		case *pb.ServerFrame_Exec:
			// accept's only error is ErrEgressWedged, and it is fatal to the
			// CONNECTION rather than to the exec: returning it here ends this session
			// so the caller re-dials, instead of continuing to accept work that can
			// never be answered (#173 item 1).
			if err := s.accept(ctx, c, m.Exec); err != nil {
				return err
			}
		case *pb.ServerFrame_Abort:
			// Cancel only — do NOT remove the slot. runOne owns the terminal frame in
			// both cases: a running exec's Run returns ErrAborted, and a queued exec
			// sees a done ctx before spawning bash and emits End{-1} without running.
			// Abort for an unknown req_id is a no-op (spec §8). The "leaves it in the
			// map" reasoning now lives on execRegistry.abort.
			c.reg.abort(m.Abort.GetReqId())
		case *pb.ServerFrame_LeaseControl:
			// Off this loop: the call itself runs on its own goroutine (it can block for
			// minutes), and a refusal goes through trySend like accept's.
			if err := s.leaseControl(ctx, c, m.LeaseControl); err != nil {
				return err
			}
		case *pb.ServerFrame_Keepalive:
			// Inline: LeaseController.LeaseKeepalive must not block.
			s.leaseKeepalive(m.Keepalive)
		}
	}
}

// accept decides an exec's fate without blocking: cached, queued, coalesced
// into an already-running duplicate, or refused. Every send here uses trySend,
// since this runs on the recv goroutine.
//
// It returns ErrEgressWedged, and only that, when a terminal frame could not be
// queued even in the reserve. Note the error describes the CONNECTION, not this
// exec — every trySend failure is treated the same way, including a dropped
// cache-hit replay. A replay looks harmless ("a duplicate of a frame already
// delivered once") but usually is not: the harness redelivers precisely because it
// never got the first answer, so dropping the replay strands that caller too.
func (s *Session) accept(ctx context.Context, c *conn, e *pb.Exec) error {
	reqID := e.GetReqId()
	fp := Fingerprint(e)

	slotCtx, cancel := context.WithCancel(ctx)

	// The decision is taken under the registry's lock; every side effect it implies is
	// performed below, after the lock is dropped. The verdict comes back as claim's
	// return value — see claim on why it is not a captured variable. cached and
	// collision are payload for a verdict already decided, and each is assigned in the
	// same statement as the outcome that makes it meaningful.
	var (
		cached    *pb.WorkerFrame
		collision bool
	)
	outcome := c.reg.claim(reqID, func(running *slot) (claimOutcome, *slot) {
		// IN-FLIGHT IS CHECKED FIRST, AHEAD OF THE CACHE — the order is load-bearing.
		// runOne calls cache.Put BEFORE sending its terminal frame, and the slot is
		// only released (by finish) after runOne returns. Consulting the cache first
		// let a duplicate arriving in that window hit the cache and replay a terminal
		// frame while the original's own terminal frame was still in flight: two
		// terminal frames for one exec, against the invariant this file asserts. The
		// window widens under backpressure — exactly when duplicates are likeliest.
		// With the slot consulted first, such a duplicate is coalesced instead. The
		// completed-redelivery path is unaffected: once finish has deleted the slot,
		// the registry misses and the cache lookup below answers it.
		if running != nil {
			if running.fp == fp {
				return claimCoalesced, nil
			}
			return claimCollision, nil
		}
		// Consulted before enqueue: a redelivery of a COMPLETED exec must not consume
		// a queue slot or a pool goroutine. Held under the registry lock so accept's
		// decision is atomic with respect to the slot map (Cache takes its own lock;
		// nothing ever acquires the registry lock while holding it, so the nesting
		// cannot deadlock).
		frame, hit, coll := s.cache.Lookup(reqID, fp)
		if hit {
			cached = frame
			return claimCacheHit, nil
		}
		collision = coll
		return claimAdmitted, &slot{ctx: slotCtx, cancel: cancel, fp: fp}
	})

	switch outcome {
	case claimCoalesced:
		cancel()
		// A genuine redelivery of a still-running exec. The original's terminal
		// frame for this req_id is already owed and on its way. Sending a refusal
		// here would be a SECOND terminal frame for one id: a caller keyed on
		// req_id would settle it as failed on this refusal, then receive the real
		// (possibly successful, possibly filesystem-mutating) result and have
		// nowhere to put it. Silently coalesce instead — the exec already owes
		// exactly one terminal frame, and it is coming.
		log.Printf("session: req_id %d already in flight; coalescing duplicate delivery", reqID)
		return nil
	case claimCollision:
		cancel()
		// NOT a redelivery: a different Exec (command, kind, mode, epoch or workspace) under an
		// id already in flight, which a req_id salt collision across harness replicas
		// still makes reachable (spec §3.1) — and the in-flight window is where it is widest, since
		// the cache cannot catch it while the original is incomplete. Coalescing
		// here would swallow genuinely different work: it would never run and never
		// get a frame at all. Refuse it instead. That cannot be a second terminal
		// frame for the same logical exec, precisely because it is a different one.
		log.Printf("session: req_id %d reused for a different Exec (command, kind, mode, epoch or workspace) "+
			"while the original is still in flight; refusing it (req_id is only probabilistically "+
			"unique across replicas — see spec §3.1)", reqID)
		if !c.trySend(errFrame(reqID, "req_id collision: a different Exec (command, mode, epoch or "+
			"workspace) is already in flight for this id")) {
			return ErrEgressWedged
		}
		return nil
	case claimCacheHit:
		cancel()
		if !c.trySend(cached) {
			return ErrEgressWedged
		}
		return nil
	case claimAdmitted:
		return s.enqueueAdmitted(c, e, reqID, cancel, collision)
	}
	// Unreachable while claim returns one of the four above, and named rather than
	// left as a fall-through on purpose: admitting is what happens when nothing else
	// applies, so a fifth outcome added without a case here would silently be treated
	// as "admit it" — enqueuing an exec whose verdict nobody handled. Failing loudly
	// costs one exec; the silent version costs the caller a 30-minute wait.
	return fmt.Errorf("session: unhandled claim outcome %d for req_id %d", outcome, reqID)
}

// enqueueAdmitted hands a freshly admitted exec to the pool, or refuses it if the
// queue is full. Split out of accept only so accept's switch can name every outcome
// instead of letting one of them be the fall-through.
func (s *Session) enqueueAdmitted(
	c *conn, e *pb.Exec, reqID uint64, cancel context.CancelFunc, collision bool,
) error {
	if collision {
		log.Printf("session: req_id %d reused for a different Exec (command, kind, mode, epoch or workspace); "+
			"running it fresh (req_id is only probabilistically unique across replicas — see spec §3.1)", reqID)
	}

	// Counted before the send, so a pool goroutine that finishes it at once cannot go below zero.
	s.inflight.Add(1)
	select {
	case c.queue <- e:
	default:
		s.inflight.Add(-1)
		// remove, not finish: this caller still holds cancel and calls it outside the
		// lock, which is the scope this branch has always had.
		c.reg.remove(reqID)
		cancel()
		s.logRefusal(reqID, len(c.queue))
		// The frame this item was filed about. The exec never ran and never will, so
		// losing this refusal loses the caller's only answer — hence the reserve, and
		// hence ending the connection if even the reserve cannot take it.
		if !c.trySend(errFrame(reqID, "busy: queue full")) {
			return ErrEgressWedged
		}
	}
	return nil
}

// deferQueue holds the terminal frames trySend could not place in the reserve (#705), in
// arrival order. pending counts them plus the one drainDeferred may hold in hand, so trySend
// sends directly only when nothing at all is waiting, and a later frame can never overtake an
// earlier one.
type deferQueue struct {
	mu      sync.Mutex
	frames  []*pb.WorkerFrame
	pending int
	wake    chan struct{}
	// closed is set when drainDeferred drops what is left and returns: from then on nothing is
	// queued here (offerTerminal).
	closed bool
}

// offerTerminal is trySend's body: it queues terminal frame f in outbound's reserve, or defers it
// behind the reserve in order (#705), and reports false only when egress is wedged. A queue that
// drainDeferred has already closed takes nothing: the connection is ending, its drainer is gone,
// and a frame counted into unsent here would never be sent or dropped, leaving Idle false for the
// life of the process. The harness fails that Exec on the disconnect, as any frame lost then.
func (s *Session) offerTerminal(q *deferQueue, outbound chan<- outFrame, sendingSince *atomic.Int64,
	wedgeAfter time.Duration, f *pb.WorkerFrame) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return true
	}
	if q.pending == 0 {
		s.unsent.Add(1)
		select {
		case outbound <- outFrame{frame: f, reserved: true}:
			return true
		default:
			s.unsent.Add(-1)
		}
	}
	if since := sendingSince.Load(); since != 0 && time.Since(time.Unix(0, since)) >= wedgeAfter {
		s.wedgedConns.Add(1)
		log.Printf("session: WARNING one Send has been blocked for over %s with %d terminal frames "+
			"waiting behind the reserve, so the terminal frame for %s cannot be delivered; treating "+
			"egress as wedged and dropping the connection so the harness re-dials",
			wedgeAfter, q.pending, frameRef(f))
		return false
	}
	if q.pending >= DeferredCap {
		s.wedgedConns.Add(1)
		log.Printf("session: WARNING %d terminal frames are waiting behind the reserve (the cap), so "+
			"the terminal frame for %s cannot be queued; treating egress as wedged and dropping the "+
			"connection so the harness re-dials", q.pending, frameRef(f))
		return false
	}
	if q.pending == 0 {
		log.Printf("session: the terminal-frame reserve (%d slots) is full; deferring terminal frames "+
			"in order until the sender drains it (first: %s)", TerminalReserve, frameRef(f))
	}
	q.frames = append(q.frames, f)
	q.pending++
	s.unsent.Add(1)
	s.deferredFrames.Add(1)
	s.deferredNow.Add(1)
	select {
	case q.wake <- struct{}{}:
	default:
	}
	return true
}

// drainDeferred moves deferred terminal frames into outbound's reserve, oldest first, blocking
// for room as a producer may. When the connection ends it drops what is left: the harness has
// already failed those Execs on the disconnect (as for any frame lost then), and the unsent
// counts are given back so Idle stays true to what is queued.
func (s *Session) drainDeferred(ctx context.Context, q *deferQueue, outbound chan<- outFrame) {
	dropAll := func() {
		q.mu.Lock()
		defer q.mu.Unlock()
		n := len(q.frames)
		s.unsent.Add(-int64(n))
		s.deferredNow.Add(-int64(n))
		q.pending -= n
		q.frames = nil
		q.closed = true
	}
	for {
		q.mu.Lock()
		for len(q.frames) == 0 {
			q.mu.Unlock()
			select {
			case <-q.wake:
			case <-ctx.Done():
				dropAll()
				return
			}
			q.mu.Lock()
		}
		f := q.frames[0]
		q.frames[0] = nil
		q.frames = q.frames[1:]
		q.mu.Unlock() // f is in hand and still counted in pending: trySend keeps deferring
		select {
		case outbound <- outFrame{frame: f, reserved: true}:
		case <-ctx.Done():
			s.unsent.Add(-1)
		}
		s.deferredNow.Add(-1)
		q.mu.Lock()
		q.pending--
		q.mu.Unlock()
		if ctx.Err() != nil {
			dropAll()
			return
		}
	}
}

// frameSink turns runner output into Chunk frames. It only ever enqueues: with
// a dedicated sender goroutine owning st.Send, Chunk itself never observes a
// send failure, so there is nothing to report and nothing to remember.
//
// dropped is the ONE thing it does remember. Bytes lost at BufferCap have no
// frame of their own — they are an absence — so the count is accumulated here and
// read once, after Run returns, to set End.truncated (#189).
type frameSink struct {
	reqID uint64
	// send is the blocking enqueue; false means the frame was not queued (see Lease).
	send func(*pb.WorkerFrame) bool
	// connDone is the connection's done channel, which Lease checks before it sends: send
	// alone still queues into a buffer with room after the connection has ended.
	connDone <-chan struct{}
	// dropped counts STDOUT bytes only — see Dropped.
	dropped int
}

func (f *frameSink) Chunk(stream pb.Stream, data []byte) error {
	f.send(&pb.WorkerFrame{Msg: &pb.WorkerFrame_Chunk{Chunk: &pb.Chunk{
		ReqId: f.reqID, Data: data, Stream: stream,
	}}})
	return nil
}

// Dropped counts STDOUT overflow only, because that is what End.truncated is about.
// The runner caps outBuf and errBuf SEPARATELY, but the harness's own cap covers
// stdout alone — grpc-relay-transport.ts excludes stderr from both its buffer and its
// byte count — and the flag makes it append the truncation marker to stdout and null
// the exit code. Summing both streams would therefore trade this fix's
// under-reporting for over-reporting: a cut stderr beside a whole stdout would
// discard a valid exit status and tell Pi that complete output was truncated.
//
// The predicate is deliberately `!= STDERR` rather than `== STDOUT`, mirroring the
// transport's byte-for-byte: STREAM_UNSPECIFIED means stdout per the proto, so the
// two ends must agree on that reading as well as on the stream.
//
// A cut stderr is logged rather than signalled. It has no wire field, and inventing
// one would need the seam to grow a second truncation concept for output it does not
// return — but going entirely silent about it is what #189 was about, so it is at
// least visible in the worker's own log.
//
// No lock of its own: the runner serializes every Sink call through one mutex, and
// guarantees none is in flight once Run has returned — the only point runOne reads
// the field.
func (f *frameSink) Dropped(stream pb.Stream, n int) {
	if stream == pb.Stream_STREAM_STDERR {
		log.Printf("session: req_id %d dropped %d bytes of stderr at the buffer cap; "+
			"End.truncated covers stdout only, so this is not signalled on the wire", f.reqID, n)
		return
	}
	f.dropped += n
}

// runOne executes one exec and sends exactly one terminal frame (spec §5).
// send is the blocking enqueue: runOne runs on a pool goroutine, not the recv
// goroutine, so backpressure here is correct rather than dangerous. connDone is the
// connection's done channel, not ctx's: an Abort ends ctx, but the connection lives on,
// so a lease event the aborted Exec reports can still be queued (see frameSink.Lease).
func (s *Session) runOne(ctx context.Context, connDone <-chan struct{}, send func(*pb.WorkerFrame) bool, e *pb.Exec) {
	reqID := e.GetReqId()
	if ctx.Err() != nil {
		// Aborted while queued: never spawn bash, but still owe a terminal frame.
		// Never truncated — nothing ran, so there was no output to cut.
		send(endFrame(reqID, -1, false))
		return
	}

	sink := &frameSink{reqID: reqID, send: send, connDone: connDone}
	code, err := s.runner.Run(ctx, wexec.Spec{
		ReqID:        reqID,
		Command:      e.GetCommand(),
		Stdin:        e.GetStdin(),
		TimeoutS:     e.GetTimeoutS(),
		Streaming:    e.GetStreaming(),
		WorkspaceKey: e.GetWorkspaceKey(),
		Mode:         specMode(e.GetMode()),
		ModeEpoch:    e.GetModeEpoch(),
		IdleTimeoutS: e.GetIdleTimeoutS(),
		Keepalive:    e.GetKeepalive(),
		Kind:         specKind(e.GetKind()),
		Process:      specProcess(e.GetProcess()),
	}, sink)

	var frame *pb.WorkerFrame
	cacheable := false
	switch {
	case err == nil:
		// code < 0 means the child was SIGNALLED while the run context was still
		// live — an OOM-kill, or an external SIGKILL — which the runner reports as
		// End{-1} with no error. Emit it, but never cache it: a signal is not a
		// determination the worker would reproduce, and caching it would poison the
		// req_id so every later redelivery answered -1 without re-running.
		frame, cacheable = endFrame(reqID, code, sink.dropped > 0), code >= 0
	case errors.Is(err, wexec.ErrTimeout):
		// Truncation is not carried here, and does not need to be: this path emits an
		// ExecError, which has no truncated field because it already tells the harness
		// the exec produced no usable result — there is no success status for a
		// truncation flag to qualify. That reasoning covers THIS case only; the abort
		// case below emits an End and must report honestly.
		frame, cacheable = errFrame(reqID, fmt.Sprintf("timeout:%d", e.GetTimeoutS())), true
	case errors.Is(err, wexec.ErrAborted):
		// An abort still delivered whatever was buffered: emitBuffered runs BEFORE the
		// exit-status switch in runner.go, so a non-streaming exec that hit BufferCap
		// and was then aborted sends exactly BufferCap bytes of Chunks ahead of this
		// frame. Declaring that untruncated is a false answer to the one question the
		// flag exists to answer, and the signalled case above already reports it.
		frame = endFrame(reqID, -1, sink.dropped > 0)
	default:
		frame = errFrame(reqID, err.Error())
	}

	// Only completed determinations are cached — a real exit status or a timeout,
	// both of which the worker would reproduce. Caching an abort, or a signalled
	// exit, would make every later redelivery of that req_id answer -1 forever
	// (spec §6.2: dedup protects completed execs only).
	if cacheable {
		s.cache.Put(reqID, Fingerprint(e), frame)
	}
	send(frame)
}

// endFrame builds the terminal success frame. truncated says the runner dropped
// output at BufferCap; a cached frame keeps it, which is right — a redelivery of a
// truncated exec is still truncated, and re-running is exactly what dedup forbids.
func endFrame(reqID uint64, code int32, truncated bool) *pb.WorkerFrame {
	return &pb.WorkerFrame{Msg: &pb.WorkerFrame_End{End: &pb.End{
		ReqId: reqID, ExitCode: code, Truncated: truncated,
	}}}
}

func errFrame(reqID uint64, msg string) *pb.WorkerFrame {
	return &pb.WorkerFrame{Msg: &pb.WorkerFrame_Error{Error: &pb.ExecError{ReqId: reqID, Message: msg}}}
}

// frameRef names what a WorkerFrame answers, for logging when trySend drops a frame:
// "req_id N" for an Exec's frames, "ctl_id N" for a LeaseControl's result. Frames with
// neither (Hello, Heartbeat) report "req_id 0".
func frameRef(f *pb.WorkerFrame) string {
	switch m := f.Msg.(type) {
	case *pb.WorkerFrame_End:
		return fmt.Sprintf("req_id %d", m.End.GetReqId())
	case *pb.WorkerFrame_Error:
		return fmt.Sprintf("req_id %d", m.Error.GetReqId())
	case *pb.WorkerFrame_Chunk:
		return fmt.Sprintf("req_id %d", m.Chunk.GetReqId())
	case *pb.WorkerFrame_Lease:
		return fmt.Sprintf("req_id %d", m.Lease.GetReqId())
	case *pb.WorkerFrame_LeaseResult:
		return fmt.Sprintf("ctl_id %d", m.LeaseResult.GetCtlId())
	default:
		return "req_id 0"
	}
}
