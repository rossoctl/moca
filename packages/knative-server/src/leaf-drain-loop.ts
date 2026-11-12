import { credentialValue } from '@moca/control-plane';
import { processOne, type LeafJobDeps, type ProcessOutcome } from '@moca/harness/leaf-job-runner';

/**
 * The slice of TurnCounter (`worker.ts:56`) this loop needs. Structural, so a test can supply the
 * real counter -- which these tests do -- without the loop depending on the runtime around it.
 */
export interface SlotCounter {
  readonly inFlight: number;
  start(): () => void;
}

export interface LeafDrainLoopDeps {
  job: LeafJobDeps;
  counter: SlotCounter;
  /** The worker's whole admission cap: an async leaf and a sync /turn share it (§5.3). */
  cap: number;
  /** Injected for the tests; defaults to processOne. */
  processOneImpl?: (deps: LeafJobDeps) => Promise<ProcessOutcome>;
  onOutcome?: (outcome: ProcessOutcome) => void;
  /**
   * A claim NOT attempted because every slot was busy. §7's `async_claim_denied_full`: "the
   * design's own stated risk made visible", since §5.3 reserves no headroom for interactive turns.
   * Only the loop can see this -- by the time anything else looks, the claim that did not happen
   * leaves no trace.
   */
  onCapDenied?: () => void;
  /**
   * How long the loop waits before claiming again when there was nothing to claim, or when every
   * slot was busy. Always slept with NO admission slot held -- the claim is non-blocking, so this
   * is the only thing keeping an idle worker from spinning on Redis.
   */
  idleBackoffMs?: number;
  errorBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface LeafDrainLoop {
  start(): void;
  /**
   * Stop claiming and release the slot. Does NOT await the in-flight leaf: MOCA_TURN_MAX_S is
   * 1800 s against a SHUTDOWN_GRACE_MS of 20 s, so waiting could only ever time out (§6.3).
   */
  stop(): Promise<void>;
  readonly running: boolean;
}

const DEFAULT_IDLE_BACKOFF_MS = 250;
const DEFAULT_ERROR_BACKOFF_MS = 1_000;

/** The async knob's accepted truths. Mirrors how deploy/vm's env examples spell booleans. */
function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Whether this worker should drain the queue at all. Off by default (§9.2: SH_ASYNC_DRAIN is this
 * slice's one operator knob), and refused -- loudly, but without failing the process, which is also
 * serving healthy sync /turn traffic -- when the knob is on but the deployment cannot support a
 * claim.
 */
export function shouldArmAsync(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  log: (msg: string) => void = console.warn,
): boolean {
  if (!truthy(env.SH_ASYNC_DRAIN)) return false;
  // SH_EXCHANGE_TOKEN is a systemd credential on deploy/vm, so it goes through credentialValue --
  // the same resolution turn-auth.ts:111 uses. It can throw on the both-set and empty-file
  // operator errors, but not newly here: prepareServerProcess already resolved this exact name at
  // worker.ts:314, so either it is readable or this process never started.
  const resolved: Record<string, string | undefined> = {
    SH_CONTROL_PLANE_URL: env.SH_CONTROL_PLANE_URL || undefined,
    SH_EXCHANGE_TOKEN: credentialValue(env as NodeJS.ProcessEnv, 'SH_EXCHANGE_TOKEN'),
  };
  const missing = (['SH_CONTROL_PLANE_URL', 'SH_EXCHANGE_TOKEN'] as const).filter(
    (k) => !resolved[k],
  );
  if (missing.length > 0) {
    log(`[async] SH_ASYNC_DRAIN set but ${missing.join(', ')} unset; not draining the leaf queue`);
    return false;
  }
  // The control plane answers async_tenancy_unsupported (501) under `multi`, so arming here would
  // be a loop that claims and refuses forever.
  if (env.MOCA_TENANCY === 'multi') {
    log('[async] SH_ASYNC_DRAIN set but MOCA_TENANCY=multi; not draining the leaf queue');
    return false;
  }
  return true;
}

/**
 * The worker's own view of its admission cap. Validated parse with a fallback, after
 * `turnsPerSubjectCap` (`subject-quota.ts:26-35`) and `statsIntervalMs` (`worker.ts:100`): a
 * malformed value must not become 0, which would refuse every leaf forever and look like an empty
 * queue.
 */
export function asyncLeafCap(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  def = 1,
): number {
  const raw = env.SH_TURNS_PER_WORKER;
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return def;
  return n;
}

export function createLeafDrainLoop(deps: LeafDrainLoopDeps): LeafDrainLoop {
  const runOne = deps.processOneImpl ?? processOne;
  const idleBackoffMs = deps.idleBackoffMs ?? DEFAULT_IDLE_BACKOFF_MS;
  const errorBackoffMs = deps.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? console.warn;

  let stopping = false;
  let started = false;
  // The slot currently held, so stop() can release it without waiting for the leaf. start()'s
  // returned function is idempotent (worker.ts:64-78), which is what makes releasing from both
  // here and the finally below correct.
  let release: (() => void) | null = null;

  // It always executes; in production it never *matters*, because every path through the loop
  // body has already awaited either queue.claim's BLOCK or a real sleep. It is here for
  // liveness: one guaranteed macrotask per iteration, so the loop can never become an unbroken
  // microtask chain. Do not remove it -- the suite OOMs without it, and in production a
  // microtask spin would wedge this process's HTTP hand-offs and IPC `drain` too, not just the
  // drain. It is deliberately NOT routed through deps.sleep: deps.sleep is the thing tests assert
  // call counts against ("does not sleep after an idle claim"), and this yield must never be
  // confused for a backoff.
  const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

  async function run(): Promise<void> {
    while (!stopping) {
      try {
        // CHECK AND TAKE IN ONE TICK (§5.3). Nothing may be awaited between these two
        // statements: the first await inside runOne is queue.claim, and any await here would let a
        // sync /turn land in the slot we just measured as free.
        // Everything in this branch -- the inFlight read, onCapDenied, the backoff sleep, and
        // counter.start() -- sits inside this try on purpose: onCapDenied and counter.start()'s
        // onChange are both injected (Task 8's metrics emitter; the real counter's process.send),
        // and a throw from either must not end the loop. This process is also serving healthy
        // sync /turn traffic, which shouldArmAsync's own doc forbids killing over an arming
        // mistake -- an injected callback's bug must not be allowed to do worse.
        if (deps.counter.inFlight >= deps.cap) {
          deps.onCapDenied?.();
          await sleep(idleBackoffMs);
        } else {
          release = deps.counter.start();
          // Decided inside the slot, SLEPT outside it -- see below.
          let backoffMs = 0;
          try {
            const outcome = await runOne(deps.job);
            if (stopping) return; // drained mid-leaf: do not report, do not claim again
            deps.onOutcome?.(outcome);
            if (outcome.kind === 'idle') backoffMs = idleBackoffMs;
          } catch (err) {
            // A claim that THREW left its entry pending, by design (turn-claim.ts). Back off so
            // a control-plane outage is a slow retry rather than a hot loop against it.
            log(`[async] claim failed: ${err instanceof Error ? err.message : String(err)}`);
            backoffMs = errorBackoffMs;
          } finally {
            release?.();
            release = null;
          }
          // WAITING HAPPENS WITHOUT A SLOT. The claim is non-blocking (leaf-job-runner's `blockMs`
          // defaults to 0), so the slot is held for about two Redis round trips and then given
          // back; the wait for work -- and the wait after a failed claim -- happens here, with
          // nothing reserved. Sleeping inside the slot instead is what made an armed-but-idle drain
          // report inFlight >= 1 essentially always, so a one-slot worker 429'd every interactive
          // /turn while the async queue was empty. §5.3's never-over-admit invariant is untouched:
          // the slot is still taken before the claim and in the same tick as the cap check.
          if (backoffMs > 0 && !stopping) await sleep(backoffMs);
        }
      } catch (err) {
        // A throwing onCapDenied, a throwing counter.start() (e.g. process.send on a closed IPC
        // channel), or a rejecting sleep land here. Release whatever this iteration might have
        // taken, log it, and back off -- then keep looping. The alternative, letting it escape
        // run(), is the thing the fallback .catch() below exists to guard against if this handler
        // itself is somehow insufficient; this one is the first line of defense and the one that
        // keeps the loop alive rather than merely keeping the process alive.
        release?.();
        release = null;
        log(`[async] drain iteration failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!stopping) await sleep(errorBackoffMs);
      }
      if (!stopping) await yieldToEventLoop();
    }
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      void run().catch((err) => {
        // Last resort. Everything run() can throw is already caught inside its own loop above;
        // this exists for the same reason packages/supervisor/src/main.ts's `route(socket)` gets
        // one: a bare `void` on a rejecting promise ends the process under Node's default
        // --unhandled-rejections=throw, taking down this worker's healthy sync /turn traffic
        // along with the drain. Mark the loop dead rather than let `running` keep reporting
        // true while nothing is happening.
        stopping = true;
        release?.();
        release = null;
        log(`[async] drain loop died: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    async stop(): Promise<void> {
      stopping = true;
      // Release the slot now so the supervisor's awaitIdle can exit early (§6.3). The in-flight
      // leaf is abandoned unacked on purpose: its heartbeat dies with the process, so another
      // worker reclaims the entry after minIdleMs.
      //
      // We deliberately do NOT call queue.deleteConsumer here. XGROUP DELCONSUMER DISCARDS that
      // consumer's pending entries, which would turn the one redelivery this design relies on into
      // silent loss. gcIdleConsumers (armed in Task 7) only ever deletes consumers whose pending is 0.
      release?.();
      release = null;
      await Promise.resolve();
    },
    get running(): boolean {
      return started && !stopping;
    },
  };
}
