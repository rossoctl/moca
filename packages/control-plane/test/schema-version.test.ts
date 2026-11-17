import { describe, expect, it, vi } from 'vitest';
import {
  SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  SchemaVersionError,
  checkSchemaVersion,
  guardSchemaVersion,
  type SchemaVersionClient,
} from '../src/index.js';

/** Just the two commands, with real SET NX semantics. */
function fakeRedis(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SCHEMA_VERSION_KEY, initial);
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async setNX(key: string, value: string) {
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

  it('accepts its own version and leaves it alone', async () => {
    const redis = fakeRedis('1');
    await expect(checkSchemaVersion(redis)).resolves.toMatchObject({ outcome: 'current' });
    expect(redis.data.get(SCHEMA_VERSION_KEY)).toBe('1');
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
