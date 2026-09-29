import { describe, it, expect, afterAll } from 'vitest';
import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { RedisSessionBackend } from '@moca/session-backend';
import { BufferedRedisBackend } from '../src/buffered-redis-backend';

const REDIS = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const store = new RedisSessionBackend<FileEntry>(REDIS);
let createdSid: string | undefined;

afterAll(async () => {
  if (createdSid) await store.reset(createdSid);
  await store.close();
});

describe('SessionManager + Redis (parity / mobility / recovery)', () => {
  it('a completed turn survives process death and a fresh instance resumes it', async () => {
    const backend = new BufferedRedisBackend(store);

    // Drive a "turn": user -> assistant -> checkpoint -> user.
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    createdSid = sm.getSessionId();
    sm.appendMessage({ role: 'user', content: 'hello' } as never);
    sm.appendMessage({ role: 'assistant', content: 'hi there' } as never);
    sm.appendCustomEntry('checkpoint', { ctx: 'reconstructed' });
    sm.appendMessage({ role: 'user', content: 'again' } as never);

    // Durability barrier (what the harness calls at turn_end).
    await backend.flush();

    // Mobility + recovery: a brand-new instance reconstructs from Redis alone.
    const resumed = await SessionManager.openFromBackend(createdSid, backend, process.cwd());

    expect(resumed.getEntries().map((e) => JSON.stringify(e))).toEqual(
      sm.getEntries().map((e) => JSON.stringify(e)),
    );

    // read(fromPosition) tail works (position 1 is the header).
    const tail = await store.read(createdSid, 4);
    expect(tail.length).toBeGreaterThan(0);

    // Checkpoint is recoverable through the decorator.
    const cp = await backend.latestCheckpoint(createdSid);
    expect((cp as { customType?: string })?.customType).toBe('checkpoint');
  });
});
