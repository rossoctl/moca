import { readFileSync } from 'node:fs';
import { ErrorReply } from 'redis';
import { describe, expect, it, vi } from 'vitest';
import {
  SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  SchemaVersionError,
  checkSchemaVersion,
  guardSchemaVersion,
  type SchemaVersionClient,
} from '../src/index.js';

const OOM = "OOM command not allowed when used memory > 'maxmemory'.";
const READONLY = "READONLY You can't write against a read only replica.";

/**
 * Just the two commands, with real SET NX semantics. `refuseSet` / `refuseGet` make Redis answer
 * those commands with an error reply, as a full (`noeviction`), read-only or ACL-limited one does;
 * `refusals` limits how many times (unlimited by default).
 */
function fakeRedis(
  initial?: string,
  opts: { refuseSet?: string; refuseGet?: string; refusals?: number } = {},
) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SCHEMA_VERSION_KEY, initial);
  let left = opts.refusals ?? Infinity;
  const refuse = (reply: string | undefined) => {
    if (reply === undefined || left <= 0) return;
    left -= 1;
    throw new ErrorReply(reply);
  };
  return {
    data,
    sets: 0,
    async get(key: string) {
      refuse(opts.refuseGet);
      return data.get(key) ?? null;
    },
    async setNX(key: string, value: string) {
      this.sets += 1;
      refuse(opts.refuseSet);
      if (data.has(key)) return 0;
      data.set(key, value);
      return 1;
    },
  };
}

describe('checkSchemaVersion (#509)', () => {
  it('names the key and starts at version 1', () => {
    expect(SCHEMA_VERSION_KEY).toBe('sh:schema-version');
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('writes the version when the key is absent', async () => {
    const redis = fakeRedis();
    await expect(checkSchemaVersion(redis)).resolves.toEqual({
      outcome: 'written',
      stored: SCHEMA_VERSION,
      known: SCHEMA_VERSION,
    });
    expect(redis.data.get(SCHEMA_VERSION_KEY)).toBe(String(SCHEMA_VERSION));
  });

  it('accepts its own version and leaves it alone, without writing', async () => {
    const redis = fakeRedis('1');
    await expect(checkSchemaVersion(redis)).resolves.toMatchObject({ outcome: 'current' });
    expect(redis.data.get(SCHEMA_VERSION_KEY)).toBe('1');
    expect(redis.sets).toBe(0);
  });

  it.each([OOM, READONLY, 'NOPERM User has no permissions to run the set command'])(
    'checks a stored version by GET alone on a Redis that refuses writes (%s)',
    async (reply) => {
      const redis = fakeRedis('1', { refuseSet: reply });
      await expect(checkSchemaVersion(redis)).resolves.toMatchObject({
        outcome: 'current',
        stored: 1,
      });
    },
  );

  it('still refuses a newer version when SET is refused', async () => {
    const redis = fakeRedis('2', { refuseSet: OOM });
    await expect(checkSchemaVersion(redis, 1)).rejects.toBeInstanceOf(SchemaVersionError);
  });

  it('lets the refusal through on an absent key, as an error reply, not a version error', async () => {
    const redis = fakeRedis(undefined, { refuseSet: OOM });
    const err = await checkSchemaVersion(redis).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErrorReply);
    expect(err).not.toBeInstanceOf(SchemaVersionError);
  });

  it('classifies what a concurrent first start wrote when its SET NX wins', async () => {
    const redis = fakeRedis();
    // Another process stamps version 2 between this GET and this SET NX.
    const racing = {
      get: redis.get.bind(redis),
      async setNX(key: string, value: string) {
        redis.data.set(key, '2');
        return redis.setNX(key, value);
      },
    };
    await expect(checkSchemaVersion(racing, 1)).rejects.toBeInstanceOf(SchemaVersionError);
  });

  it('refuses a newer version, naming both', async () => {
    const redis = fakeRedis('2');
    const err = await checkSchemaVersion(redis, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaVersionError);
    expect((err as Error).message).toContain('schema version 2');
    expect((err as Error).message).toContain('the 1 this release knows');
    // Never overwritten: the newer release's stamp must survive an older one's start.
    expect(redis.data.get(SCHEMA_VERSION_KEY)).toBe('2');
  });

  it('accepts an older version (the previous release wrote it) and does not raise it', async () => {
    const redis = fakeRedis('1');
    await expect(checkSchemaVersion(redis, 2)).resolves.toEqual({
      outcome: 'older',
      stored: 1,
      known: 2,
    });
    expect(redis.data.get(SCHEMA_VERSION_KEY)).toBe('1');
  });

  it.each(['0', '-1', '1.0', ' 1', '2x', 'v1', ''])(
    'refuses %j, which is not a version',
    async (raw) => {
      const redis = fakeRedis(raw);
      await expect(checkSchemaVersion(redis)).rejects.toBeInstanceOf(SchemaVersionError);
      expect(redis.data.get(SCHEMA_VERSION_KEY)).toBe(raw);
    },
  );
});

/** A client whose connect fails `failures` times, then serves `redis`. */
function fakeClients(redis: ReturnType<typeof fakeRedis>, failures = 0) {
  const made: Array<{ destroyed: boolean }> = [];
  let left = failures;
  const newClient = (): SchemaVersionClient => {
    const state = { destroyed: false, open: false };
    made.push(state);
    return {
      get isOpen() {
        return state.open && !state.destroyed;
      },
      on: () => undefined,
      connect: async () => {
        if (left > 0) {
          left -= 1;
          throw new Error('connect ECONNREFUSED');
        }
        state.open = true;
      },
      destroy: () => {
        state.destroyed = true;
      },
      get: (k) => redis.get(k),
      setNX: (k, v) => redis.setNX(k, v),
    };
  };
  return { made, newClient };
}

describe('guardSchemaVersion (#509)', () => {
  const quiet = { log: () => undefined, error: () => undefined };

  it('writes an absent key once Redis answers, retrying meanwhile, and closes its client', async () => {
    const redis = fakeRedis();
    const { made, newClient } = fakeClients(redis, 2);
    const exit = vi.fn();
    const error = vi.fn();
    await guardSchemaVersion({
      component: 't',
      url: 'redis://x',
      retryMs: 0,
      newClient,
      exit,
      ...quiet,
      error,
    });
    expect(redis.data.get(SCHEMA_VERSION_KEY)).toBe(String(SCHEMA_VERSION));
    expect(exit).not.toHaveBeenCalled();
    expect(made).toHaveLength(3);
    expect(made.at(-1)!.destroyed).toBe(true);
    // The outage is reported once, not per attempt.
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('exits 1 on a newer version, saying why', async () => {
    const redis = fakeRedis('7');
    const { newClient } = fakeClients(redis);
    const exit = vi.fn();
    const error = vi.fn();
    await guardSchemaVersion({
      component: 'cp',
      url: 'redis://x',
      newClient,
      exit,
      ...quiet,
      error,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0]![0]).toMatch(/^\[cp\] refusing to run: .*schema version 7/);
  });

  it('runs on against an older version', async () => {
    const redis = fakeRedis('1');
    const { newClient } = fakeClients(redis);
    const exit = vi.fn();
    const log = vi.fn();
    await guardSchemaVersion({
      component: 'cp',
      url: 'redis://x',
      known: 2,
      newClient,
      exit,
      ...quiet,
      log,
    });
    expect(exit).not.toHaveBeenCalled();
    expect(log.mock.calls[0]![0]).toContain('older');
  });

  it('on a refused write to an absent key: says so once, does not exit, backs off, and lands the check once the refusal clears', async () => {
    const redis = fakeRedis(undefined, { refuseSet: OOM, refusals: 4 });
    const { made, newClient } = fakeClients(redis);
    const exit = vi.fn();
    const error = vi.fn();
    const log = vi.fn();
    await guardSchemaVersion({
      component: 'cp',
      url: 'redis://x',
      retryMs: 0,
      newClient,
      exit,
      error,
      log,
    });
    expect(exit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatch(/^\[cp\] redis schema version unknown: Redis refused/);
    expect(error.mock.calls[0]![0]).toContain('OOM command not allowed');
    expect(made).toHaveLength(5);
    expect(redis.data.get(SCHEMA_VERSION_KEY)).toBe(String(SCHEMA_VERSION));
    expect(log.mock.calls[0]![0]).toContain('written');
  });

  it('doubles the back-off after error replies, up to its cap', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedis(undefined, {
        refuseGet: 'NOPERM no permissions to run get',
        refusals: 5,
      });
      const { made, newClient } = fakeClients(redis);
      const done = guardSchemaVersion({
        component: 'cp',
        url: 'redis://x',
        retryMs: 100,
        maxBackoffMs: 400,
        newClient,
        exit: () => undefined,
        ...quiet,
      });
      const attemptsAfter = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        return made.length;
      };
      expect(await attemptsAfter(0)).toBe(1);
      expect(await attemptsAfter(100)).toBe(2); // waited 100
      expect(await attemptsAfter(199)).toBe(2);
      expect(await attemptsAfter(1)).toBe(3); // waited 200
      expect(await attemptsAfter(400)).toBe(4); // waited 400
      expect(await attemptsAfter(400)).toBe(5); // capped at 400
      expect(await attemptsAfter(400)).toBe(6); // the sixth GET is answered
      await done;
      expect(redis.data.get(SCHEMA_VERSION_KEY)).toBe(String(SCHEMA_VERSION));
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits on a newer version even when Redis refuses writes', async () => {
    const redis = fakeRedis('5', { refuseSet: READONLY });
    const { newClient } = fakeClients(redis);
    const exit = vi.fn();
    await guardSchemaVersion({ component: 'cp', url: 'redis://x', newClient, exit, ...quiet });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('never logs the URL, which carries the Redis password', async () => {
    const redis = fakeRedis('9');
    const { newClient } = fakeClients(redis, 1);
    const lines: string[] = [];
    const sink = (l: string) => void lines.push(l);
    await guardSchemaVersion({
      component: 'cp',
      url: 'redis://:hunter2@redis:6379',
      retryMs: 0,
      newClient,
      exit: () => undefined,
      log: sink,
      error: sink,
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('hunter2');
  });
});

/**
 * The wiring, pinned cheaply: each long-running process that writes this Redis arms the guard in
 * its entry-point block (not in a function tests call), naming itself.
 */
describe('guardSchemaVersion is armed by each entry point (#509)', () => {
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  it.each([
    ['../src/main.ts', 'if (isMainModule) {', 'control-plane'],
    ['../../server/src/worker.ts', 'if (isMainModule) {', 'sh-worker'],
    [
      '../../sandbox-relay/src/main.ts',
      'if (import.meta.url === `file://${process.argv[1]}`) {',
      'sandbox-relay',
    ],
  ])('%s', (file, mainBlock, component) => {
    const text = src(file);
    const block = text.indexOf(mainBlock);
    const call = text.indexOf(`guardSchemaVersion({\n`, block);
    expect(block).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(block);
    expect(text.slice(call, call + 200)).toContain(`component: '${component}'`);
  });
});
