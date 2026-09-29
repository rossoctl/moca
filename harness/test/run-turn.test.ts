import { describe, it, expect, afterAll } from 'vitest';
import { RedisSessionBackend } from '@moca/session-backend';
import type { FileEntry } from '@earendil-works/pi-coding-agent';
import { runTurn, executeTurn, wireAbort } from '../src/run-turn.js';

const REDIS = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const store = new RedisSessionBackend<FileEntry>(REDIS);
const createdSessions: string[] = [];

// These cases call the real model through the gateway. Gate them so CI does not fail on an
// ungated live call (e.g. stopReason variance). Run with SH_RUN_LIVE=1 + ANTHROPIC_AUTH_TOKEN.
const LIVE = process.env.SH_RUN_LIVE === '1' && !!process.env.ANTHROPIC_AUTH_TOKEN;

afterAll(async () => {
  for (const sid of createdSessions) {
    await store.reset(sid);
  }
  await store.close();
});

describe('runTurn()', () => {
  it.runIf(LIVE)('creates a new session when sessionId is undefined', async () => {
    const result = await runTurn('Say exactly: PONG', undefined, {
      redisUrl: REDIS,
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.response).toContain('PONG');
    expect(result.stopReason).toBe('end_turn');
    createdSessions.push(result.sessionId);
  });

  it.runIf(LIVE)('resumes an existing session from Redis', async () => {
    // Create a session first
    const first = await runTurn('Remember the code word: ZEBRA42', undefined, {
      redisUrl: REDIS,
    });
    createdSessions.push(first.sessionId);

    // Resume and ask for recall
    const second = await runTurn('What was the code word I told you?', first.sessionId, {
      redisUrl: REDIS,
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.response).toContain('ZEBRA42');
  });

  it('throws when sessionId does not exist in Redis', async () => {
    await expect(
      runTurn('hello', 'nonexistent-session-id-12345', { redisUrl: REDIS }),
    ).rejects.toThrow('no session in backend');
  });
});

describe('executeTurn / runTurn 404 contract', () => {
  it('exposes executeTurn as the shared core', () => {
    expect(typeof executeTurn).toBe('function');
  });

  it('executeTurn with createIfAbsent:false throws when the session is absent', async () => {
    await expect(
      executeTurn({
        prompt: 'hello',
        sessionId: 'nonexistent-session-id-98765',
        config: { redisUrl: REDIS },
        createIfAbsent: false,
      }),
    ).rejects.toThrow('no session in backend');
  });
});

describe('wireAbort', () => {
  it('calls session.abort() immediately when the signal is already aborted', () => {
    let aborted = 0;
    const ac = new AbortController();
    ac.abort();
    wireAbort(ac.signal, {
      abort: () => {
        aborted++;
      },
    });
    expect(aborted).toBe(1);
  });

  it('calls session.abort() once when the signal fires later, and is idempotent', () => {
    let aborted = 0;
    const ac = new AbortController();
    wireAbort(ac.signal, {
      abort: () => {
        aborted++;
      },
    });
    expect(aborted).toBe(0);
    ac.abort();
    expect(aborted).toBe(1);
    ac.abort(); // listener registered { once: true } — no second call
    expect(aborted).toBe(1);
  });
});
