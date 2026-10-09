import { createServer, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { abortDetachedTurns, handler } from './server.js';
// Boot-time validation of the sandbox-discovery enum; see its use below.
import { resolveDiscoverySource } from '@moca/harness/select-sandbox';
// ...and of the sandbox tier settings (P6.3), likewise.
import { parseSandboxTiers } from '@moca/harness/sandbox-affinity';
// Shared boot preparation (keyset validation, tenancy, ambient-credential scrub) -- this path has to
// call it itself because it never goes through startServer. See its use below.
import { prepareServerProcess } from './server-process.js';
import { attachTurnSlot } from './turn-slot.js';

/**
 * Worker → supervisor. Four rows: the first three are exactly P6 §3.9's; the fourth, `stats`,
 * is deliberately advisory (added by Task 11, not §3.9) — never routed on, never merged into
 * the supervisor's `WorkerView` (see `packages/supervisor/src/pool.ts`).
 */
export type WorkerToSupervisor =
  | { type: 'ready'; pid: number }
  | { type: 'load'; inFlight: number }
  | { type: 'draining' }
  | {
      type: 'stats';
      loopLagP99Ms?: number;
      rssBytes?: number;
      leasesHeld?: number;
      leasePoolSize?: number;
      fileOpP95Ms?: number;
    };

/**
 * Supervisor → worker. A `conn` rides in `child.send(msg, socket)`'s handle slot; `head`
 * is base64 of the bytes the supervisor pre-read to route (sticky mode only, §3.4).
 */
export type SupervisorToWorker = { type: 'conn'; head?: string } | { type: 'drain' };

/** The two turn routes `server.ts:641` matches, by exact URL equality as it does. */
const TURN_PATHS = new Set(['/turn', '/v1/turn']);

/**
 * Does this request consume a turn slot? Mirrors `server.ts:641` exactly — including that
 * it compares the *raw* target, so `/turn?sid=x` is not a turn there and must not be one
 * here either. Divergence would make the worker's in-flight count describe a different set
 * of requests than the ones it actually runs.
 */
export function isTurnRequest(method: string | undefined, url: string | undefined): boolean {
  return method === 'POST' && TURN_PATHS.has(url ?? '');
}

/**
 * In-flight turn count. The worker is the authority (§3.9); the supervisor's copy is an
 * estimate it reconciles from `load`.
 */
export class TurnCounter {
  private n = 0;
  constructor(private readonly onChange: (inFlight: number) => void) {}

  get inFlight(): number {
    return this.n;
  }

  /** Marks a turn started; returns an **idempotent** end function. */
  start(): () => void {
    this.n += 1;
    this.onChange(this.n);
    let ended = false;
    return () => {
      // One-shot on purpose. A second decrement (an abort path that also calls end) would
      // bias the supervisor's estimate permanently low — silent over-admission forever.
      if (ended) return;
      ended = true;
      this.n -= 1;
      this.onChange(this.n);
    };
  }
}

export interface WorkerRuntime {
  readonly server: Server;
  readonly counter: TurnCounter;
  /** Serve one handed-off socket. `head` is any bytes the supervisor already consumed. */
  accept(socket: Socket, head?: Buffer): void;
  drain(): void;
}

/**
 * The stats interval, validated the way the supervisor's own `readInt` validates its knobs.
 *
 * This was `Number(env.SH_STATS_INTERVAL_MS ?? 1000)`, the one numeric env parse outside config.ts's
 * validation. A non-numeric value yields NaN, and `setInterval(fn, NaN)` coerces the delay to 0 --
 * a hot timer sending IPC messages as fast as the loop allows, inside the process whose event-loop
 * lag E8 measures. The blast radius is small (advisory telemetry, and the timer is unref'd), but the
 * guard costs one line and the failure is silent without it.
 *
 * Rejects non-integers and non-positives alike: 0 is the same hot timer by another route, and a
 * negative is coerced to it too.
 */
export function statsIntervalMs(env: NodeJS.ProcessEnv, def = 1000): number {
  const raw = env.SH_STATS_INTERVAL_MS;
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : def;
}

/**
 * How long a draining worker lets detached turns run before it aborts them with "harness
 * restarting" (turn-reattach spec §5.5). Under compose and k8s the supervisor is PID 1, so its exit
 * SIGKILLs the workers and the IPC `disconnect` path never runs: the terminal frame has to be
 * written before then. Must stay below the supervisor's SHUTDOWN_GRACE_MS (20 s,
 * packages/supervisor/src/main.ts) so the abort, its terminal writes, and the in-flight count
 * dropping (which lets `awaitIdle` exit early) all land inside the grace.
 */
export const DETACHED_DRAIN_MS = 15_000;

/** Arms the drain deadline for detached turns; unref'd, so it never holds the process open. */
export function armDetachedDrain(
  abort: () => unknown,
  ms = DETACHED_DRAIN_MS,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => void abort(), ms);
  timer.unref();
  return timer;
}

export function createWorkerRuntime(opts: {
  send: (msg: WorkerToSupervisor) => void;
  requestHandler?: RequestListener;
}): WorkerRuntime {
  const { send } = opts;
  const counter = new TurnCounter((inFlight) => send({ type: 'load', inFlight }));
  // Never listen(). This server exists only to own an HTTP parser and the request/response
  // plumbing for sockets that arrive over IPC. Binding a port would make the worker
  // independently reachable and put two admission controllers in the system.
  const baseHandler = opts.requestHandler ?? handler;
  const wrappedHandler: RequestListener = (req, res) => {
    if (isTurnRequest(req.method, req.url)) {
      // 'close' covers both a finished response and a client abort, which is what "the turn is no
      // longer occupying this process" means -- unless the route adopts the slot for a detachable
      // turn, which then outlives its response (turn-reattach spec §5.5).
      attachTurnSlot(res, counter.start());
    }
    baseHandler(req, res);
  };
  const server = createServer(wrappedHandler);
  let draining = false;

  send({ type: 'ready', pid: process.pid });

  return {
    server,
    counter,
    accept(socket: Socket, head?: Buffer): void {
      // The supervisor credits its estimate +1 for EVERY connection it hands off (§3.9's
      // optimistic increment), but `load` is only ever sent from the turn counter above, and a
      // non-turn request -- GET /health, POST /runs, a monitoring probe, a port scan -- returns
      // early there. So without a report here the estimate rose by one PERMANENTLY per non-turn
      // connection: after S of them every worker read as saturated, every later connection was
      // refused BEFORE hand-off, so no turn could arrive to reconcile, and the pool stayed
      // wedged in 429s until a worker happened to crash.
      //
      // Once per CONNECTION, not per request: the turn counter already reports both edges of
      // every turn, so a keep-alive socket carrying many turns adds exactly one message here,
      // at the end. The value is the ABSOLUTE current count rather than a decrement, so a
      // connection closing while turns are still in flight on other sockets reports the truth
      // instead of erasing them. Non-turn requests are still not counted as turns (§3.5) --
      // what this adds is a reconciliation signal, not a second count.
      // Reported on ACCEPT as well as on close, because the close-only version closed the wedge
      // only for a connection that ENDS, not for one that is HELD. S x W sockets that are handed
      // off, issue no turn, and stay alive (a `GET /health` every few seconds is enough -- this
      // server sets no timeouts, so keepAliveTimeout never fires on a socket that keeps making
      // requests) drive every slot's estimate to S. main.ts then refuses every new connection
      // BEFORE hand-off, so no turn can arrive, so no `load` can arrive, so nothing reconciles: the
      // pool is wedged in 429s until a worker crashes. It needs no attacker -- a load balancer or a
      // monitoring probe on persistent connections accumulates the same way, and S is meant to be
      // small. At S=1 it is ONE held connection.
      //
      // It is also invisible while it happens: `spurious_refusals` can only be incremented by
      // reconcile() on a `load` reporting lower than the refusal estimate, and the wedge is exactly
      // the state where no `load` arrives, so the counter designed to detect it cannot fire.
      //
      // The trade, stated plainly because it inverts a deliberate bias: reporting on accept means a
      // real turn's connection momentarily reports its PRE-turn count, so the estimate dips for one
      // IPC round trip and the pool can over-admit. That over-admission is bounded by the round
      // trip, is already accepted by §3.9, and is already counted (`over_admission`). The wedge is
      // unbounded, uninstrumented, and clears only on a crash. Keeping the 'close' report as well
      // costs one message per connection and keeps the keep-alive-with-turns case exact.
      send({ type: 'load', inFlight: counter.inFlight });
      // Defence against a handle-less `conn`. Node can deliver a queued handle-send with no
      // handle attached (if the descriptor was consumed elsewhere first), and the parameter is
      // typed `Socket` only because `process.on('message')` casts what it is given. Emitting
      // `undefined` as a connection throws `TypeError: Cannot convert undefined or null to
      // object` out of the message handler, uncaught -- killing a worker that may be
      // multiplexing S turns. A supervisor bug must cost one connection, not the process.
      //
      // Deliberately BELOW the report above, not before it. `handOff` credits `slot.inFlight += 1`
      // for every `conn` it sends, INCLUDING one that arrives with no handle, so returning ahead of
      // the report left that credit in place permanently -- the same unbounded wedge the comment
      // above closes, reached by a different door: at S=1 one handle-less `conn` saturates the slot,
      // every later connection is refused before hand-off, no turn arrives, so no `load` arrives to
      // reconcile, and `spurious_refusals` cannot fire for the reason given above. Ordering it this
      // way costs nothing: the value reported is the ABSOLUTE current turn count, which does not
      // depend on whether this particular handle arrived.
      if (socket === undefined || socket === null) return;
      socket.once('close', () => send({ type: 'load', inFlight: counter.inFlight }));
      // The socket arrived as a file descriptor, which carries no JS-side buffer: bytes the
      // supervisor read to make its routing decision are gone from the kernel buffer too.
      // They must be unshifted HERE, onto the stream this process is about to read.
      // Unshifting them in the supervisor would push them onto a stream nobody reads again
      // and silently truncate the request line — the request would hang or 400.
      if (head && head.length > 0) socket.unshift(head);
      server.emit('connection', socket);
    },
    drain(): void {
      if (draining) return;
      draining = true;
      send({ type: 'draining' });
      // Stop keep-alive reuse; in-flight turns run to completion on their own sockets.
      server.closeIdleConnections();
    },
  };
}

/**
 * Advisory telemetry for `/metrics` (§5.2, Task 11). `monitorEventLoopDelay` is a *cumulative*
 * histogram: left un-reset it reports the p99 since process boot, so a late rung's reading
 * would carry every earlier rung's and no rung would be individually attributable.
 */
export function startStatsReporter(opts: {
  send: (msg: WorkerToSupervisor) => void;
  intervalMs: number;
  lag?: () => number;
  rss?: () => number;
}): () => void {
  const h = opts.lag ? undefined : monitorEventLoopDelay({ resolution: 10 });
  h?.enable();
  const timer = setInterval(() => {
    const lag = opts.lag ? opts.lag() : h!.percentile(99) / 1e6; // ns -> ms
    // Reset per interval: an un-reset histogram reports the p99 since boot, so rung 32's
    // reading would carry rung 1's and no rung would be attributable.
    h?.reset();
    opts.send({
      type: 'stats',
      loopLagP99Ms: lag,
      rssBytes: opts.rss ? opts.rss() : process.memoryUsage.rss(),
    });
  }, opts.intervalMs);
  timer.unref(); // telemetry must never be the reason a worker refuses to exit
  return () => {
    clearInterval(timer);
    h?.disable();
  };
}

/** `--role=turn` / `--role turn`. Round one drives turns only (§3.3, §8). */
export function parseRole(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a?.startsWith('--role=')) return a.slice('--role='.length);
    if (a === '--role') return argv[i + 1] ?? '';
  }
  return 'turn';
}

const entry = process.argv[1];
const isMainModule = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isMainModule) {
  const role = parseRole(process.argv.slice(2));
  if (role !== 'turn') {
    // The flag exists so leaf mode is a later experiment, not a later redesign (§3.3).
    console.error(`--role=${role} is not implemented in round one; only --role=turn is`);
    process.exit(2);
  }
  const channel = process.send;
  if (typeof channel !== 'function') {
    console.error('sh-worker must be forked by @moca/supervisor (no IPC channel available)');
    process.exit(2);
  }
  // Validate SH_SANDBOX_DISCOVERY at BOOT, not on the first turn. resolveDiscoverySource throws on
  // an unrecognised value, but its only other caller is selectPoolSandbox on the turn path -- so
  // `SH_SANDBOX_DISCOVERY=record` (or `grpc`) used to boot cleanly, pass /health, and fail every
  // turn. SH_ROUTING_POLICY, added by the same change, is validated at boot by policyFromName; this
  // is the same kind of enum with the opposite failure mode.
  //
  // Not hypothetical here: deploy/vm/env/supervisor.env.example sets it explicitly, so it is a value
  // an operator edits rather than inherits. It is also the shape #249 closed as a must-fix -- a
  // keyset parsed per request rather than at boot, giving "failure arrives per request on a
  // healthy-looking deployment" -- and assertKeysetUsable, the fix there, lives in this same package.
  //
  // In the worker rather than the supervisor because resolveDiscoverySource is in @moca/harness and
  // packages/supervisor ships `dependencies: {}` deliberately. A throw here still surfaces as a
  // crashloop with the reason in the journal, via the supervisor's restart backoff. The records-
  // without-SH_REMOTE_SANDBOX=1 combination is covered by the same call, and deserves to be: it is a
  // static property of the unit file, and discovering it on the first turn wastes a whole bring-up.
  //
  // The keyset is the other half of the same argument, and it needs an explicit call here rather
  // than inheriting one: `startServer` runs `prepareServerProcess(process.env)` "before anything
  // binds" (server.ts:657), and this path deliberately bypasses `startServer` altogether -- bare
  // `createServer(handler)`, never `listen()`. So under the supervisor a malformed
  // SH_SESSION_TOKEN_PUBLIC_KEYS stopped being a boot failure: every worker reported `ready`,
  // served GET /health, and 503'd every authenticated /turn. Citing #249's fix as this block's own
  // precedent while not calling it left the regression it closed open on exactly this deployment.
  //
  // MI1 §5 R2: prepareServerProcess is the SAME function startServer calls, so both entry points
  // validate tenancy and scrub ambient credentials identically -- there is no separate worker-only
  // boot path for that check to drift from.
  //
  // SH_SANDBOX_TIERS / SH_SANDBOX_DEFAULT_TIER (P6.3 spec §3.4): the selection still reads them per
  // call (select-sandbox.ts, `parseSandboxTiers(env)` in selectPoolSandbox), but a typo must fail
  // the bring-up, not the first turn -- the same argument as the discovery check above.
  try {
    prepareServerProcess(process.env);
    resolveDiscoverySource(process.env, process.env.SH_REMOTE_SANDBOX === '1');
    parseSandboxTiers(process.env);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(2);
  }
  // process.send is overloaded three ways in @types/node; pin the signature we actually use
  // before .call() so tsc doesn't resolve .call to a differently-shaped overload.
  const sendToSupervisor = channel as (this: NodeJS.Process, msg: WorkerToSupervisor) => boolean;
  const send = (msg: WorkerToSupervisor): void => {
    sendToSupervisor.call(process, msg);
  };
  const runtime = createWorkerRuntime({ send });
  const stopStats = startStatsReporter({
    send,
    intervalMs: statsIntervalMs(process.env),
  });
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  process.on('message', (msg: SupervisorToWorker, handle) => {
    if (msg.type === 'conn') {
      runtime.accept(handle as Socket, msg.head ? Buffer.from(msg.head, 'base64') : undefined);
      return;
    }
    if (msg.type === 'drain') {
      // A draining worker goes quiet rather than keep reporting lag for work it is no
      // longer taking.
      stopStats();
      runtime.drain();
      // Detached turns that finish within DETACHED_DRAIN_MS finish normally; the rest get their
      // terminal frame before the supervisor's grace runs out and SIGKILLs this process.
      drainTimer ??= armDetachedDrain(() =>
        abortDetachedTurns('restarting').catch(() => undefined),
      );
    }
  });
  // Supervisor crash or shutdown ⇒ the IPC channel closes ⇒ we exit, so systemd restarts the whole
  // set rather than leaving orphaned workers holding sockets nobody routes to (§6). Detached turns
  // get a terminal frame first (turn-reattach spec §5.5); abortDetachedTurns bounds its own wait.
  process.on('disconnect', () => {
    void abortDetachedTurns('restarting').finally(() => process.exit(0));
  });
}
