import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Defect B (#423, Task 16b): `makeRuntimeReporter` built its node-redis client with no `'error'`
 * listener. node-redis re-emits a dropped socket as `'error'` on the client, and an `'error'` with no
 * listener is an uncaught exception -- so a Redis restart crashed every worker that had served a turn,
 * killing the turns in flight on it (seen live on Kind: `worker_exit … code 1` after `delete pod
 * redis-0`). The reporter's try/catch covers its awaited commands, never the emitter.
 *
 * These use the REAL node-redis client against real sockets: a closed port, and a server that accepts
 * and then drops the connection the moment a command arrives (a Redis restart, as the client sees it).
 * The module is passed through untouched; the wrapper only records each client the reporter builds.
 */
const created = vi.hoisted(
  () => [] as { emit: (e: string, err: Error) => boolean; isOpen: boolean }[],
);
vi.mock('redis', async (importOriginal) => {
  const real = await importOriginal<typeof import('redis')>();
  return {
    ...real,
    createClient: (...args: Parameters<typeof real.createClient>) => {
      const c = real.createClient(...args);
      created.push(c as never);
      return c;
    },
  };
});
const { makeRuntimeReporter } = await import('../src/turn-auth.js');

/** A port nothing listens on: bind an ephemeral one, then release it. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Accepts connections and destroys each one as soon as the client sends anything. */
async function droppingServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    sock.on('data', () => sock.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let uncaught: unknown[];
const onUncaught = (e: unknown) => void uncaught.push(e);
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  created.length = 0;
  uncaught = [];
  process.on('uncaughtException', onUncaught);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  process.off('uncaughtException', onUncaught);
  errorLog.mockRestore();
});

/** Let any socket events still queued after the call surface before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('makeRuntimeReporter survives Redis client errors (#423 Task 16b, defect B)', () => {
  it('against a closed port: resolves, and a client error afterwards neither throws nor goes uncaught', async () => {
    const url = `redis://:pa55word@127.0.0.1:${await closedPort()}`; // notsecret
    // A reduced reconnect bound (the test seam) so the refused connect gives up in milliseconds.
    const reporter = makeRuntimeReporter(url, 1);

    await expect(reporter('sid-1', { harnessPod: 'p' })).resolves.toBeUndefined();
    expect(created).toHaveLength(1);

    // The emitter path the try/catch cannot cover. With no listener this rethrows.
    expect(() => created[0]!.emit('error', new Error('Socket closed unexpectedly'))).not.toThrow();
    await settle();
    expect(uncaught).toEqual([]);
    expect(created[0]!.isOpen).toBe(false); // the failed client was closed, not left retrying

    // Logged as one line each, message only: never the URL or its password.
    expect(errorLog).toHaveBeenCalled();
    for (const call of errorLog.mock.calls) {
      expect(call).toHaveLength(1);
      expect(String(call[0])).not.toContain('\n');
      expect(String(call[0])).not.toContain('pa55word');
      expect(String(call[0])).not.toContain(url);
    }
  });

  it('a connection that drops under a command (a Redis restart) is no uncaught exception, and the call resolves', async () => {
    const server = await droppingServer();
    try {
      const reporter = makeRuntimeReporter(`redis://127.0.0.1:${server.port}`, 1);

      // Raced against a deadline: without the listener the throw escapes node-redis's own error
      // handling half-way, so the command is never flushed and the call never settles. The uncaught
      // exception is the finding; the hang is its symptom here.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        reporter('sid-1', { harnessPod: 'p' }).then(() => 'resolved'),
        new Promise((r) => (deadline = setTimeout(() => r('still pending after 2 s'), 2000))),
      ]);
      clearTimeout(deadline);
      await settle();

      expect(uncaught.map((e) => String(e))).toEqual([]);
      expect(outcome).toBe('resolved');
      // The client it discarded is closed, so nothing is left reconnecting after the test.
      expect(created.length).toBeGreaterThan(0);
      for (const c of created) expect(c.isOpen).toBe(false);
      expect(errorLog.mock.calls.map((c) => String(c[0]))).toEqual(
        expect.arrayContaining([expect.stringContaining('Socket closed unexpectedly')]),
      );
    } finally {
      await server.close();
    }
  });
});
