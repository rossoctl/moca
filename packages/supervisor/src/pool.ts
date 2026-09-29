import type { Socket } from 'node:net';
import { refuse } from './admission.js';
import { pickLeastLoaded, type WorkerView } from './routing.js';

/**
 * Duplicated from `@moca/knative-server/src/worker.ts` deliberately (spec §9): the supervisor
 * forks the worker as a PROCESS, and a shared type module would advertise an in-process
 * coupling that does not exist. Drift fails a test rather than rotting, because
 * `test/real-worker.integration.test.ts` forks the REAL worker and drives all four rows across
 * the boundary. Until that test existed the duplication was protected by nothing: every other
 * integration test substitutes an untyped `.mjs` fixture that re-implements the contract by
 * hand, so a divergence between the two copies would have gone unnoticed.
 */
export type SupervisorToWorker = { type: 'conn'; head?: string } | { type: 'drain' };
/**
 * §3.9 defines the first three rows; the pool's routing decisions are built on exactly those.
 * `stats` is a fourth, deliberately advisory row (not in §3.9): it carries telemetry for
 * `/metrics` and must never be routed on or merged into `WorkerView` (see `telemetry()` and
 * `aggregates()` below).
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
 * Advisory per-worker telemetry (§5.2's `/metrics`), kept deliberately separate from
 * `WorkerView`: nothing here may influence a routing decision. `id`/`inFlight`/`healthy`
 * duplicate `WorkerView`'s fields (for a single self-describing row on the wire), but this
 * type is never fed back into routing and `WorkerView` is never extended with the rest.
 * Missing readings are NaN, never a fabricated number — see `aggregates()`.
 */
export interface WorkerTelemetry {
  readonly id: number;
  readonly pid: number | undefined;
  readonly inFlight: number;
  readonly healthy: boolean;
  readonly loopLagP99Ms: number;
  readonly rssBytes: number;
}

/** Pool-wide rollup of telemetry not carried per-worker, for `/metrics`'s top-level fields. */
export interface TelemetryAggregates {
  readonly leaseSaturation: number;
  readonly fileOpP95Ms: number;
}

/** The narrow slice of `ChildProcess` the pool uses, so tests can hand it a fake. */
export interface WorkerHandle {
  readonly pid?: number;
  /** `ChildProcess.connected`: false once the IPC channel is gone. A real failure signal. */
  readonly connected: boolean;
  send(msg: SupervisorToWorker, handle?: Socket): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'message', listener: (msg: WorkerToSupervisor) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  /** `ChildProcess`'s own error channel. See `spawn()` for why the pool must listen to it. */
  on(event: 'error', listener: (err: Error) => void): this;
}

export interface PoolOptions {
  readonly workers: number;
  readonly fork: (id: number) => WorkerHandle;
  readonly restartBackoffMs?: number;
  readonly healthyRunMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => void;
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface PoolCounters {
  readonly restarts: number;
  readonly handoffRetries: number;
  readonly handoffFailures: number;
  readonly overAdmission: number;
  readonly spuriousRefusals: number;
  /** Connections whose header block exceeded MAX_HEAD_BYTES, so they routed with no affinity. */
  readonly headTruncations: number;
}

const MAX_BACKOFF_MS = 30_000;

interface Slot {
  handle: WorkerHandle;
  /** Supervisor ESTIMATE (§3.9), not ground truth. */
  inFlight: number;
  healthy: boolean;
  startedAt: number;
  crashes: number;
  drained: boolean;
  /** Estimate for this slot at the moment of the pending refusal, if any. */
  refusalEstimate?: number;
  /**
   * Advisory telemetry (`stats`, §5.2). NaN until a worker actually reports a reading -- 0
   * would read as "no lag" / "no leases held" and would exonerate whichever tier actually
   * saturated, defeating the point of carrying this telemetry at all.
   */
  loopLagP99Ms: number;
  rssBytes: number;
  leasesHeld: number;
  leasePoolSize: number;
  fileOpP95Ms: number;
}

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly opts: Required<
    Pick<PoolOptions, 'restartBackoffMs' | 'healthyRunMs' | 'now' | 'setTimer' | 'log'>
  > &
    PoolOptions;
  private shuttingDown = false;
  private idleWaiters: Array<() => void> = [];
  private refusalSeq = 0;
  private refusalCounted = true;
  private tally = {
    restarts: 0,
    handoffRetries: 0,
    handoffFailures: 0,
    overAdmission: 0,
    spuriousRefusals: 0,
    headTruncations: 0,
  };

  constructor(opts: PoolOptions) {
    this.opts = {
      restartBackoffMs: 250,
      healthyRunMs: 10_000,
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        setTimeout(fn, ms).unref?.();
      },
      log: (line) => {
        console.log(JSON.stringify(line));
      },
      ...opts,
    };
    for (let id = 0; id < opts.workers; id += 1) this.spawn(id);
  }

  get size(): number {
    return this.slots.length;
  }

  get counters(): PoolCounters {
    return { ...this.tally };
  }

  views(): readonly WorkerView[] {
    return this.slots.map((s, id) => ({ id, inFlight: s.inFlight, healthy: s.healthy }));
  }

  /** Advisory per-worker telemetry for `/metrics`. Never consulted by routing. */
  telemetry(): readonly WorkerTelemetry[] {
    return this.slots.map((s, id) => ({
      id,
      pid: s.handle.pid,
      inFlight: s.inFlight,
      healthy: s.healthy,
      loopLagP99Ms: s.loopLagP99Ms,
      rssBytes: s.rssBytes,
    }));
  }

  /**
   * Pool-wide rollup of the telemetry `telemetry()` does not carry per-worker. Lease
   * saturation is held-over-pool-size, with pool size taken as the MAX any worker reported:
   * every worker leases from the SAME pool, so summing would report it W times its real size
   * and hide saturation entirely. File-op p95 is the WORST worker's, not the mean -- an
   * averaged p95 is not a p95 of anything and would hide the one relay that is the reason a
   * rung degraded.
   */
  aggregates(): TelemetryAggregates {
    const held = this.slots.filter((s) => Number.isFinite(s.leasesHeld));
    const size = Math.max(
      ...this.slots.map((s) => (Number.isFinite(s.leasePoolSize) ? s.leasePoolSize : 0)),
      0,
    );
    const leaseSaturation =
      held.length === 0 || size <= 0
        ? Number.NaN
        : held.reduce((a, s) => a + s.leasesHeld, 0) / size;

    const ops = this.slots.map((s) => s.fileOpP95Ms).filter((n) => Number.isFinite(n));
    const fileOpP95Ms = ops.length === 0 ? Number.NaN : Math.max(...ops);
    return { leaseSaturation, fileOpP95Ms };
  }

  handOff(preferred: number, socket: Socket, head?: Buffer): number | undefined {
    const tried = new Set<number>();
    let target: number | undefined = preferred;
    while (target !== undefined) {
      tried.add(target);
      const slot = this.slots[target];
      const msg: SupervisorToWorker =
        head && head.length > 0
          ? { type: 'conn', head: head.toString('base64') }
          : { type: 'conn' };
      if (slot !== undefined && slot.healthy && slot.handle.connected) {
        try {
          // NEVER branch on send()'s return value. While a handle is in flight awaiting Node's
          // internal NODE_HANDLE_ACK, further sends are QUEUED AND STILL DELIVERED, and the
          // boolean reports queue position rather than success: the third and later handle sent
          // inside one tick returns false (measured `[true,true,false,false,false,false]` for
          // six sends, all six delivered with their handle). Treating that as failure retries a
          // socket that has already been handed over -- and because the fd hand-off is
          // destructive, exactly one worker ends up with the descriptor while the other gets a
          // handle-less `conn` and dies. The real failure signals are an unhealthy slot, a
          // disconnected channel, and a thrown exception; those are the three consulted here.
          slot.handle.send(msg, socket);
          // Optimistic: the worker's own `load` will correct this within one round trip (§3.9).
          slot.inFlight += 1;
          return target;
        } catch {
          // The channel closed between the `connected` check above and the send. Fall through
          // to the retry rather than throw out of the connection callback.
        }
      }
      this.tally.handoffRetries += 1;
      this.opts.log({ event: 'handoff_retry', from: target });
      // §6: a worker can die between selection and hand-off. Retry the next-least-loaded
      // rather than fail the connection on a race the design accepts.
      target = pickLeastLoaded(this.views().filter((v) => !tried.has(v.id)));
    }
    // Never just drop it: a forgotten socket is a leaked fd, and on a saturation ladder that
    // is the leak that ends the run.
    //
    // Answered with back-pressure rather than a bare reset, because reaching here IS the state
    // `main.ts` answers 429 for one branch earlier: every healthy worker gone in the window
    // between `policy.pick()` and the send, i.e. a restart. `socket.destroy()` gave the client an
    // ECONNRESET/empty reply for a condition the same supervisor answers cleanly a few lines up,
    // and a driver cannot tell that apart from the supervisor having crashed -- on an E8 rung a
    // bare reset is a different data point from a back-pressure signal. It also skipped
    // `noteRefusal()`, so the refusal was never stamped and `reconcile()` could never later count
    // it as spurious. `refuse()` ends the socket and bounds the fd with its own linger (see
    // REFUSAL_LINGER_MS), so the leak this comment is about is still closed.
    this.tally.handoffFailures += 1;
    this.opts.log({ event: 'handoff_failed', preferred });
    this.noteRefusal();
    refuse(socket);
    return undefined;
  }

  /**
   * Record that a connection's header block hit the cap, so it routed with NO session affinity
   * (see `head.ts`'s MAX_HEAD_BYTES). Counted rather than merely logged because it is a
   * measurement effect on E8's sticky arm: unrecorded it reads as a low hit rate with nothing in
   * the data to distinguish it from a genuine null result.
   */
  noteHeadTruncated(bytes: number): void {
    this.tally.headTruncations += 1;
    this.opts.log({ event: 'head_truncated', bytes });
  }

  /**
   * Record that a 429 was issued with the current estimates. The next `load` from any worker
   * decides whether the pool could actually have served it (§3.9, §5.2).
   */
  noteRefusal(): void {
    this.refusalSeq += 1;
    this.refusalCounted = false;
    for (const slot of this.slots) slot.refusalEstimate = slot.inFlight;
  }

  /** True ⇒ no worker's estimate shows a turn in flight. */
  private get allIdle(): boolean {
    return this.slots.every((s) => s.inFlight <= 0);
  }

  private notifyIfIdle(): void {
    if (!this.allIdle) return;
    for (const fn of this.idleWaiters.splice(0, this.idleWaiters.length)) fn();
  }

  /**
   * Resolves `true` once every worker reports no in-flight turn, or `false` when `timeoutMs`
   * elapses first. Shutdown awaits this so §3.9's "in-flight turns run to completion" actually
   * happens: closing the IPC channels first makes every worker's `'disconnect'` handler exit it
   * at once, killing every turn mid-flight. The bound matters as much as the wait -- one stuck
   * turn would otherwise hold the supervisor open until systemd SIGKILLed it at
   * `TimeoutStopSec`.
   */
  awaitIdle(timeoutMs: number): Promise<boolean> {
    if (this.allIdle) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const onIdle = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== onIdle);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.idleWaiters.push(onIdle);
    });
  }

  drainAll(): void {
    this.shuttingDown = true;
    for (const slot of this.slots) {
      if (slot.drained) continue;
      slot.drained = true;
      // `connected` FIRST, the same real failure signal `handOff` consults. It is not merely an
      // optimisation: `ChildProcess.send()` to a closed channel does not throw, so the catch below
      // never sees it -- it reports asynchronously as `emit('error', ERR_IPC_CHANNEL_CLOSED)` on the
      // child (node:internal/child_process, the no-callback branch). A dead worker is already
      // drained by virtue of being dead, so skipping the send is also the honest description.
      if (!slot.handle.connected) continue;
      try {
        slot.handle.send({ type: 'drain' });
      } catch {
        // A channel that is already gone needs no drain, and must not abandon the drain of
        // every later worker -- this is the first step of shutdown. Kept for the SYNCHRONOUS
        // throws; the asynchronous ones are handled by the 'error' listener in spawn().
      }
    }
  }

  private spawn(id: number): void {
    const previous = this.slots[id];
    const handle = this.opts.fork(id);
    const slot: Slot = {
      handle,
      inFlight: 0,
      // Unhealthy until `ready`: before that the worker has not constructed its handler
      // server, so a socket handed to it would arrive with no parser attached.
      healthy: false,
      startedAt: this.opts.now(),
      crashes: previous?.crashes ?? 0,
      drained: false,
      loopLagP99Ms: NaN,
      rssBytes: NaN,
      leasesHeld: NaN,
      leasePoolSize: NaN,
      fileOpP95Ms: NaN,
    };
    this.slots[id] = slot;

    // Required, not defensive. `ChildProcess.send()` does NOT throw when the channel is closed: with
    // no callback it does `process.nextTick(() => this.emit('error', ERR_IPC_CHANNEL_CLOSED))`. On a
    // child with no 'error' listener that is an unhandled 'error' event, i.e. an uncaughtException
    // that ends the SUPERVISOR -- so every `try { handle.send(...) } catch` in this file was
    // protecting against the one shape this failure never takes.
    //
    // Reachable on the ordinary shutdown path, not a corner: whenever any worker is already dead (a
    // crashloop, an OOM kill, a boot-validation exit), `close()` calls `drainAll()`, which sent to
    // that dead channel -- and the supervisor died mid-drain, before `awaitIdle`, taking every
    // in-flight turn on every OTHER worker with it. Precisely the outcome the ordered `close()`
    // exists to prevent. `drainAll` now checks `connected` as well; this listener closes the race
    // between that check and the send, and any other async child error.
    //
    // Logged and otherwise ignored: 'exit' is the event that carries meaning for a gone worker, and
    // it already restarts the slot with backoff. This exists so the absence of a listener cannot be
    // fatal.
    handle.on('error', (err) => {
      this.opts.log({ event: 'worker_channel_error', id, err: String(err) });
    });

    handle.on('message', (msg) => {
      if (msg.type === 'ready') {
        // A drained slot stays unhealthy. Without this guard a late or duplicate `ready` from a
        // worker that is finishing its last turns put it back in the routing set, and the pool
        // handed it new connections while it was shutting down.
        if (slot.drained) {
          this.opts.log({ event: 'ready_ignored_draining', id, pid: msg.pid });
          return;
        }
        slot.healthy = true;
        this.opts.log({ event: 'worker_ready', id, pid: msg.pid });
        return;
      }
      if (msg.type === 'draining') {
        // Stop routing, do not kill: in-flight turns run to completion.
        slot.healthy = false;
        return;
      }
      if (msg.type === 'stats') {
        // Advisory only (§5.2): recorded for `/metrics`, never merged into `WorkerView` and
        // never consulted by `reconcile()` or any routing policy.
        if (msg.loopLagP99Ms !== undefined) slot.loopLagP99Ms = msg.loopLagP99Ms;
        if (msg.rssBytes !== undefined) slot.rssBytes = msg.rssBytes;
        if (msg.leasesHeld !== undefined) slot.leasesHeld = msg.leasesHeld;
        if (msg.leasePoolSize !== undefined) slot.leasePoolSize = msg.leasePoolSize;
        if (msg.fileOpP95Ms !== undefined) slot.fileOpP95Ms = msg.fileOpP95Ms;
        return;
      }
      // Exhaustively narrowed to `{ type: 'load'; inFlight: number }` by the four returns
      // above -- this IS the load handler (§3.9), not a fallthrough. A fifth row added to the
      // union without a branch above will fail to compile here, not silently no-op.
      //
      // A worker from a different build can still send a type this union does not know. Do not
      // reconcile on it: `reconcile` trusts the worker and would assign `undefined`, and because
      // every comparison against `undefined` is false, `pickLeastLoaded` would then pin this
      // slot as `best` until the next real `load`. Guard the VALUE, not the type -- reading
      // `msg.inFlight` here is what makes a fifth row a compile error, so the guard must keep
      // reading it.
      if (!Number.isFinite(msg.inFlight)) {
        this.opts.log({ event: 'unrecognised_message', id, type: (msg as { type: unknown }).type });
        return;
      }
      this.reconcile(id, slot, msg.inFlight);
    });

    handle.on('exit', (code, signal) => {
      slot.healthy = false;
      // A dead worker holds no turn. Its estimate must not be what a shutdown waits on, or a
      // worker that crashed mid-turn would burn the whole grace period.
      slot.inFlight = 0;
      this.notifyIfIdle();
      if (this.shuttingDown) return; // the whole set is going away
      const ranFor = this.opts.now() - slot.startedAt;
      if (ranFor >= this.opts.healthyRunMs) slot.crashes = 0;
      const delay = Math.min(this.opts.restartBackoffMs * 2 ** slot.crashes, MAX_BACKOFF_MS);
      slot.crashes += 1;
      this.tally.restarts += 1;
      this.opts.log({
        event: 'worker_exit',
        id,
        code,
        signal,
        ranForMs: ranFor,
        restartInMs: delay,
      });
      // In-flight turns die here; the sessions survive in Redis. That is E4's existing
      // pod-eviction semantics, not a new contract (§6).
      this.opts.setTimer(() => {
        if (!this.shuttingDown) this.spawn(id);
      }, delay);
    });
  }

  private reconcile(id: number, slot: Slot, actual: number): void {
    const estimate = slot.inFlight;
    slot.inFlight = actual; // the worker is the authority (§3.9)
    // The only place the estimate can FALL, so the only place a shutdown wait can complete.
    this.notifyIfIdle();

    if (actual > estimate) {
      this.tally.overAdmission += 1;
      this.opts.log({ event: 'over_admission', id, estimate, actual });
    }

    const atRefusal = slot.refusalEstimate;
    if (atRefusal === undefined) return;
    slot.refusalEstimate = undefined;
    if (actual < atRefusal && !this.refusalCounted) {
      // The estimate was stale HIGH when we refused: the pool had capacity it did not offer.
      // Counted once per refusal, so W workers reporting lower is one event, not W.
      this.refusalCounted = true;
      this.tally.spuriousRefusals += 1;
      this.opts.log({
        event: 'refusal_reconciled',
        seq: this.refusalSeq,
        id,
        estimate: atRefusal,
        actual,
      });
    }
  }
}
