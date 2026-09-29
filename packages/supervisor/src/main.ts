import { fork } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSaturated, refuse } from './admission.js';
import { startAdminServer } from './admin.js';
import { readConfig, type SupervisorConfig } from './config.js';
import { readHead, sessionIdFromHead } from './head.js';
import { WorkerPool, type WorkerHandle } from './pool.js';

export interface Supervisor {
  readonly port: number;
  readonly adminPort: number;
  readonly pool: WorkerPool;
  close(): Promise<void>;
}

/**
 * The worker entry point, resolved through the pnpm workspace layout rather than a package
 * export: spec §9 keeps `@moca/knative-server`'s public surface at `startServer` only, and the
 * supervisor forks this file as a process, so it needs a path and not an import.
 */
export const DEFAULT_WORKER_ENTRY = fileURLToPath(
  new URL('../../knative-server/src/worker.ts', import.meta.url),
);

/**
 * How long shutdown lets in-flight turns finish before it stops waiting.
 *
 * A CHOSEN value, pending a spec sentence: §3.9 requires that in-flight turns run to completion
 * but names no deadline, and that gap is recorded separately. Deliberately not an env var --
 * one more knob whose right value nobody knows is worse than one documented constant. The
 * units' own `TimeoutStopSec=120` is the outer bound, and 20s sits well inside it on purpose,
 * so systemd's SIGKILL stays a genuine backstop for a supervisor that has hung rather than a
 * race against this timer.
 */
export const SHUTDOWN_GRACE_MS = 20_000;

export async function startSupervisor(opts: {
  config: SupervisorConfig;
  workerEntry?: string;
  log?: (line: Record<string, unknown>) => void;
  /** Overrides `SHUTDOWN_GRACE_MS`; tests use a short one. Not an env var by design. */
  shutdownGraceMs?: number;
}): Promise<Supervisor> {
  const { config } = opts;
  const workerEntry = opts.workerEntry ?? DEFAULT_WORKER_ENTRY;
  const graceMs = opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  const log = opts.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));

  const pool = new WorkerPool({
    workers: config.workers,
    restartBackoffMs: config.restartBackoffMs,
    log,
    fork: (id) =>
      // execArgv is inherited, so a supervisor started under `--import tsx` forks TypeScript
      // workers without a second loader flag.
      fork(workerEntry, ['--role=turn'], {
        stdio: 'inherit',
        env: { ...process.env, SH_WORKER_ID: String(id) },
      }) as unknown as WorkerHandle,
  });

  // pauseOnConnect: without it, Node starts reading each accepted socket into its own
  // JS-level buffer before this callback even runs (net.Server's default). Those bytes would
  // never reach the worker: only the OS-level fd is duplicated across the hand-off, not
  // whatever the parent already pulled into userspace. Staying paused keeps every byte in the
  // kernel socket buffer until the worker's own reader starts it, which is what makes "the
  // supervisor reads no byte of the request" (below) actually true for policies that don't
  // pre-read the head.
  const server: Server = createServer({ pauseOnConnect: true }, (socket: Socket) => {
    // net.Server, unlike http.Server, attaches no 'error' handler to accepted sockets. Without
    // this a write to a departed peer -- which is what refuse() does, under exactly the
    // overload that makes peers depart -- raises an unhandled 'error' and takes the whole
    // supervisor down with every worker it owns. An error listener reads no request bytes, so
    // GC9 is untouched. It also covers the window between readHead() resolving (head.ts's
    // finish() removes its own 'error' listener) and the fd reaching a worker.
    socket.on('error', () => {
      /* peer gone; there is nothing to write and nothing useful to log per connection */
    });
    // Same failure class as the 'error' listener above, by a different door. `route` is async, so
    // anything it throws is a rejected promise; a bare `void` declines to handle it, and Node's
    // default unhandledRejection mode throws -- ending the process. Every worker then exits on its
    // own 'disconnect' handler as the IPC channels close, and Restart=always brings back a
    // supervisor that has lost every in-flight turn. Today's body is safe (handOff catches its own send failures,
    // readHead only resolves, socket.end() on a dead socket does not throw), but `config.policy.pick`
    // is injected and a future policy could throw -- and the whole reason this callback is a one-line
    // dispatcher is that a supervisor must survive anything one connection can do.
    void route(socket).catch((err) => {
      // destroy() rather than leaving it: a forgotten socket is a leaked fd, the same reasoning
      // handOff applies to a hand-off it could not complete.
      log({ event: 'route_failed', err: String(err) });
      socket.destroy();
    });
  });

  async function route(socket: Socket): Promise<void> {
    // Admission FIRST, and before any read: §3.5 puts the 429 before hand-off, and refusing
    // without touching the request also means a saturated supervisor does no per-connection
    // parsing work at exactly the moment it has none to spare.
    if (isSaturated(pool.views(), config.turnsPerWorker)) {
      pool.noteRefusal();
      refuse(socket);
      return;
    }

    let head: Buffer | undefined;
    let sessionId: string | undefined;
    if (config.policy.needsHead) {
      const read = await readHead(socket);
      // A peer that hung up or RST'd during the pre-read leaves nothing to hand off, and handing it
      // off anyway KILLED A WORKER. Measured, because it is worse than it looks:
      // `child.send(msg, deadSocket)` does not throw, so `handOff`'s catch never runs and the two
      // counters that would have shown it stay at zero (`handoff_retries: 0`,
      // `handoff_failures: 0`). The child receives a `conn` whose handle is a socket it cannot use
      // and exits -- one abandoned connection produced `worker_exit code: 1` and `restarts: 1`,
      // taking every turn that worker was multiplexing with it. That is the same class as the
      // handle-less-`conn` defect `pool.ts`'s send comment exists for, reached from the other end,
      // and client-side abandonment is commonest at exactly the saturation knee E8 measures.
      if (read.outcome === 'closed') {
        // Destroyed rather than merely dropped. With `allowHalfOpen` false the socket usually
        // tears itself down on 'end' already, but "never leave an fd to chance" is the same rule
        // `handOff` applies to a hand-off it could not complete, and destroy() is idempotent.
        socket.destroy();
        return;
      }
      head = read.bytes;
      // An incomplete head still routes: the supervisor does not adjudicate HTTP, so the
      // worker's parser issues the 400 (or completes the request) as it would have anyway.
      sessionId = read.complete ? sessionIdFromHead(read.bytes) : undefined;
      // A cap hit means this connection routes with NO affinity. Counted, not silent: on the
      // sticky arm an unrecorded one reads as a low hit rate with nothing in the data to
      // separate it from a genuine null result. Only 'cap' -- a timeout or a hang-up is the
      // client's behaviour, not a measurement effect of ours.
      if (read.outcome === 'cap') pool.noteHeadTruncated(read.bytes.length);
    }

    const chosen = config.policy.pick(pool.views(), { sessionId });
    if (chosen === undefined) {
      // Every worker went unhealthy between the check and here — a restart window.
      pool.noteRefusal();
      refuse(socket);
      return;
    }
    pool.handOff(chosen, socket, head);
    // From here the supervisor is entirely off the data path (§3.2). It holds no reference to
    // the socket, reads no byte of the request, and writes no byte of the response.
  }

  server.listen(config.port, '0.0.0.0');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  log({ event: 'supervisor_listening', port, workers: config.workers, policy: config.policy.name });

  // Separate listener from the data-path `net.Server` above: an `http.Server` here would add
  // per-connection HTTP parsing to the hot path for every worker connection, not just /metrics.
  const admin = await startAdminServer({ pool, port: config.adminPort, env: process.env });
  log({ event: 'admin_listening', port: admin.port });

  return {
    port,
    adminPort: admin.port,
    pool,
    async close(): Promise<void> {
      // Order is load-bearing. This used to await the admin server, then the data server, then
      // drainAll() -- so workers kept accepting new turns throughout the teardown, and
      // `shutdown()` then called process.exit(0) immediately, closing the IPC channels so every
      // worker's 'disconnect' handler exited it at once. §3.9's "in-flight turns run to
      // completion" never happened.

      // 1. Stop workers taking NEW turns, before anything closes.
      pool.drainAll();
      log({ event: 'shutdown_step', step: 'drained' });

      // 2. Stop accepting. Captured eagerly: `server.close()` can emit 'close' before step 5
      //    gets there, and a `once()` registered afterwards would wait forever. Handed-off
      //    sockets are unaffected -- the supervisor holds none.
      const dataClosed = once(server, 'close');
      server.close();
      log({ event: 'shutdown_step', step: 'accepting_stopped' });

      // 3. Let in-flight turns finish (§3.9), bounded. See SHUTDOWN_GRACE_MS for why bounded.
      const drained = await pool.awaitIdle(graceMs);
      log({ event: 'shutdown_step', step: drained ? 'turns_finished' : 'grace_expired' });

      await admin.close();
      log({ event: 'shutdown_step', step: 'admin_closed' });

      await dataClosed;
      log({ event: 'shutdown_step', step: 'data_closed' });
    },
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const supervisor = await startSupervisor({ config: readConfig(process.env) });
  let stopping = false;
  const shutdown = (): void => {
    // systemd sends one SIGTERM, but an impatient operator sends a second Ctrl-C. Re-entering
    // close() would restart the drain wait from zero, which is the opposite of what the second
    // signal is asking for.
    if (stopping) return;
    stopping = true;
    // Same reasoning as `route`'s catch above: an unhandled rejection here would end the process
    // via the default handler instead of via this exit path -- and on the shutdown path that means
    // skipping the drain the close() is FOR, killing in-flight turns systemd was willing to wait
    // for. Exit non-zero so a failed drain is distinguishable in the journal from a clean stop.
    void supervisor.close().then(
      () => process.exit(0),
      (err: unknown) => {
        // console.log rather than startSupervisor's injected `log`, which is not in scope here --
        // this is the module's own entry path, and it matches that logger's default anyway.
        console.log(JSON.stringify({ event: 'shutdown_failed', err: String(err) }));
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
