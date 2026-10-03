import { describe, it, expect, vi } from 'vitest';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { startSupervisor } from '../src/main.js';

// A worker that comes up, reports ready, and serves nothing. Enough to prove the supervisor
// binds, forks, and refuses when the pool is at cap.
const inertWorker = fileURLToPath(new URL('./fixtures/inert-worker.mjs', import.meta.url));

describe('startSupervisor', () => {
  it('binds the configured port and forks the pool', async () => {
    const sup = await startSupervisor({
      config: readConfig({
        PORT: '0',
        SH_ADMIN_PORT: '0',
        SH_WORKERS: '1',
        SH_TURNS_PER_WORKER: '1',
      } as NodeJS.ProcessEnv),
      workerEntry: inertWorker,
      log: () => {},
    });
    expect(sup.port).toBeGreaterThan(0);
    expect(sup.pool.size).toBe(1);
    await sup.close();
  });

  it('logs the admin bind address, not just the port', async () => {
    // On Kubernetes SH_ADMIN_HOST is 0.0.0.0 (kubelet probes and the pod-network allowlist); on the
    // VM it is loopback. The log line is how an operator tells which one a pod actually bound.
    const logs: Array<Record<string, unknown>> = [];
    const sup = await startSupervisor({
      config: readConfig({
        PORT: '0',
        SH_ADMIN_PORT: '0',
        SH_ADMIN_HOST: '127.0.0.1',
        SH_WORKERS: '1',
        SH_TURNS_PER_WORKER: '1',
      } as NodeJS.ProcessEnv),
      workerEntry: inertWorker,
      log: (l) => logs.push(l),
    });
    try {
      expect(logs.find((l) => l.event === 'admin_listening')).toEqual({
        event: 'admin_listening',
        port: sup.adminPort,
        address: '127.0.0.1',
      });
    } finally {
      await sup.close();
    }
  });

  it('refuses with 429 while no worker is ready yet', async () => {
    // Not a contrived state: it is every restart window, and a hang here would look like a
    // saturation knee on an E8 rung.
    const sup = await startSupervisor({
      config: readConfig({
        PORT: '0',
        SH_ADMIN_PORT: '0',
        SH_WORKERS: '1',
        SH_TURNS_PER_WORKER: '1',
      } as NodeJS.ProcessEnv),
      workerEntry: fileURLToPath(new URL('./fixtures/silent-worker.mjs', import.meta.url)),
      log: () => {},
    });
    const client = connect(sup.port, '127.0.0.1');
    await once(client, 'connect');
    client.write('POST /turn HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n');
    const chunks: Buffer[] = [];
    client.on('data', (c: Buffer) => chunks.push(c));
    await once(client, 'end');
    expect(Buffer.concat(chunks).toString()).toContain('429 Too Many Requests');
    client.destroy();
    await sup.close();
  });

  it('survives refusing a connection whose peer is already gone', async () => {
    // `net.Server`, unlike `http.Server`, attaches no 'error' handler to accepted sockets. So
    // refuse()'s resume()+write against a departed peer raised an UNHANDLED 'error' and took
    // the whole supervisor down -- and with it every worker, each of which exits on
    // 'disconnect'. refuse() is reached only under overload, which is exactly when clients
    // time out and abandon connections sitting in the accept backlog: a self-inflicted total
    // outage at the moment E8 is measuring the knee.
    //
    // Driven with REAL sockets rather than a synthetic emit: `resetAndDestroy()` sends an RST,
    // which is what an abandoned connection looks like on the wire, and the accepted socket
    // has no listener of ours on it at all -- a synthetic emit would need a handle to the
    // server-side socket that nothing outside `startSupervisor` has.
    //
    // The pin has two halves, because in-process the harness survives what a real process
    // would not: the assertions below prove the listener still serves, and vitest's
    // unhandled-error detection fails the RUN (nonzero exit) if the 'error' listener goes
    // away. Unfixed, this produced 25 uncaught `Error: write EPIPE` from `refuse()`.
    const sup = await startSupervisor({
      config: readConfig({
        PORT: '0',
        SH_ADMIN_PORT: '0',
        SH_WORKERS: '1',
        SH_TURNS_PER_WORKER: '1',
        // silent-worker never reports ready, so isSaturated() is true and EVERY connection
        // below takes the refuse() path.
      } as NodeJS.ProcessEnv),
      workerEntry: fileURLToPath(new URL('./fixtures/silent-worker.mjs', import.meta.url)),
      log: () => {},
    });

    for (let i = 0; i < 25; i += 1) {
      const c = connect(sup.port, '127.0.0.1');
      await once(c, 'connect');
      c.resetAndDestroy();
    }

    // The supervisor must still be here and the listener must still serve.
    const survivor = connect(sup.port, '127.0.0.1');
    await once(survivor, 'connect');
    survivor.write('POST /turn HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n');
    const chunks: Buffer[] = [];
    survivor.on('data', (c: Buffer) => chunks.push(c));
    await once(survivor, 'end');
    expect(Buffer.concat(chunks).toString()).toContain('429 Too Many Requests');
    survivor.destroy();
    await sup.close();
  }, 20_000);
});

describe('shutdown (§3.9)', () => {
  function shutdownEnv(): NodeJS.ProcessEnv {
    return {
      PORT: '0',
      SH_ADMIN_PORT: '0',
      SH_WORKERS: '1',
      SH_TURNS_PER_WORKER: '2',
    } as NodeJS.ProcessEnv;
  }

  it('drains the pool BEFORE it closes either listener', async () => {
    // The old order awaited the admin server, then the data server, then drainAll() -- so a
    // worker was still accepting new turns while the listeners came down, and if the admin
    // close blocked (see the next case) drainAll() never ran at all.
    const logs: Array<Record<string, unknown>> = [];
    const sup = await startSupervisor({
      config: readConfig(shutdownEnv()),
      workerEntry: inertWorker,
      log: (l) => logs.push(l),
      shutdownGraceMs: 250,
    });
    await sup.close();
    expect(logs.filter((l) => l.event === 'shutdown_step').map((l) => l.step)).toEqual([
      'drained',
      'accepting_stopped',
      'turns_finished',
      'admin_closed',
      'data_closed',
    ]);
  }, 20_000);

  it('a warm /metrics keep-alive connection does not block shutdown', async () => {
    // A characterisation guard, not a bug reproduction: measured on Node 23.6,
    // `http.Server.close()` already closes idle keep-alive connections itself (it has since Node
    // 19), so this does NOT fail without `closeIdleConnections()`. It is here because /metrics
    // exists to be polled on a warm connection, so "a poller cannot hold shutdown open" is a
    // property worth stating -- and it would fail loudly if that Node behaviour ever regressed
    // or if the admin listener grew a long-lived streaming route.
    const sup = await startSupervisor({
      config: readConfig(shutdownEnv()),
      workerEntry: inertWorker,
      log: () => {},
      shutdownGraceMs: 250,
    });
    const warm = connect(sup.adminPort, '127.0.0.1');
    await once(warm, 'connect');
    warm.write('GET /metrics HTTP/1.1\r\nHost: x\r\n\r\n');
    // Response received and the connection deliberately left open, exactly as an agent would.
    await once(warm, 'data');

    await sup.close();
    warm.destroy();
  }, 20_000);

  it('stops after the grace period when a turn never finishes', async () => {
    // inert-worker reports `ready` and then never sends `load`, so the estimate below never
    // reconciles: shutdown must give up at the deadline rather than wait for systemd's SIGKILL.
    const logs: Array<Record<string, unknown>> = [];
    const sup = await startSupervisor({
      config: readConfig(shutdownEnv()),
      workerEntry: inertWorker,
      log: (l) => logs.push(l),
      shutdownGraceMs: 150,
    });
    await vi.waitFor(() => expect(sup.pool.views()[0]!.healthy).toBe(true));
    // Occupy the estimate with no prospect of a reconciling `load`: inert-worker has no
    // 'message' handler at all, so the fd arrives and is simply never served. The socket comes
    // from a throwaway listener rather than the supervisor's own data port, so that the
    // supervisor's connection callback does not route a second socket of its own and make the
    // estimate -- and therefore this assertion -- racy.
    const scratch = createServer();
    scratch.listen(0, '127.0.0.1');
    await once(scratch, 'listening');
    const stuck = connect((scratch.address() as { port: number }).port, '127.0.0.1');
    await once(stuck, 'connect');
    sup.pool.handOff(0, stuck);
    expect(sup.pool.views()[0]!.inFlight).toBe(1);

    const started = Date.now();
    await sup.close();
    const steps = logs.filter((l) => l.event === 'shutdown_step').map((l) => l.step);
    expect(steps).toContain('grace_expired');
    expect(steps).not.toContain('turns_finished');
    // Bounded: nowhere near TimeoutStopSec=120.
    expect(Date.now() - started).toBeLessThan(10_000);
    scratch.close();
  }, 20_000);
});
