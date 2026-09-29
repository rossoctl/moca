import { describe, it, expect, afterAll } from 'vitest';
import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { RedisSessionBackend } from '@moca/session-backend';
import { BufferedRedisBackend } from '../src/buffered-redis-backend';
import { checkpointExtension } from '../src/checkpoint-extension';

const REDIS = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const store = new RedisSessionBackend<FileEntry>(REDIS);
const sids: string[] = [];

afterAll(async () => {
  for (const sid of sids) await store.reset(sid);
  await store.close();
});

describe('SessionManager.openFromCheckpoint', () => {
  it('loads only the tail slice from a checkpoint marker', async () => {
    const backend = new BufferedRedisBackend(store);
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    const sid = sm.getSessionId();
    sids.push(sid);

    sm.appendMessage({ role: 'user', content: 'one' } as never); // ~pos 2
    const keepId = sm.appendMessage({ role: 'assistant', content: 'two' } as never); // ~pos 3
    sm.appendMessage({ role: 'user', content: 'three' } as never); // ~pos 4
    await backend.flush();

    const resumeFrom = await store.positionOfId(sid, keepId);
    expect(resumeFrom).not.toBeNull();
    sm.appendCustomEntry('checkpoint', { resumeFromPosition: resumeFrom }); // marker
    await backend.flush();

    const resumed = await SessionManager.openFromCheckpoint(sid, backend, process.cwd());
    const tail = await store.read(sid, resumeFrom!);
    // Reconstructed entry ids equal exactly the stored tail slice (firstKept..marker).
    expect(resumed.getEntries().map((e) => (e as { id?: string }).id)).toEqual(
      tail.map((r) => (r.entry as { id?: string }).id),
    );
    // The slice is strictly smaller than the full log.
    const full = await store.read(sid);
    expect(tail.length).toBeLessThan(full.length);
  });

  it('falls back to full reconstruction when there is no marker', async () => {
    const backend = new BufferedRedisBackend(store);
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    const sid = sm.getSessionId();
    sids.push(sid);
    sm.appendMessage({ role: 'user', content: 'hi' } as never);
    sm.appendMessage({ role: 'assistant', content: 'hello' } as never);
    await backend.flush();

    const viaCheckpoint = await SessionManager.openFromCheckpoint(sid, backend, process.cwd());
    const viaBackend = await SessionManager.openFromBackend(sid, backend, process.cwd());
    expect(viaCheckpoint.getEntries().map((e) => JSON.stringify(e))).toEqual(
      viaBackend.getEntries().map((e) => JSON.stringify(e)),
    );
  });
});

describe('checkpointExtension', () => {
  it("writes a checkpoint marker pointing at the compaction's firstKeptEntryId on session_compact", async () => {
    const backend = new BufferedRedisBackend(store);
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    const sid = sm.getSessionId();
    sids.push(sid);

    sm.appendMessage({ role: 'user', content: 'q' } as never);
    const firstKeptId = sm.appendMessage({ role: 'assistant', content: 'a' } as never);
    sm.appendCompaction('summary so far', firstKeptId, 1234);
    await backend.flush();

    // Capture the session_compact handler the extension registers.
    const handlers: Record<string, Function> = {};
    const pi = {
      on: (ev: string, h: Function) => {
        handlers[ev] = h;
      },
    };
    checkpointExtension(store, sm)(pi as never);

    await handlers.session_compact({ compactionEntry: { firstKeptEntryId: firstKeptId } });
    await backend.flush();

    const marker = await backend.latestCheckpoint(sid);
    const expectedPos = await store.positionOfId(sid, firstKeptId);
    expect((marker as { customType?: string })?.customType).toBe('checkpoint');
    expect((marker as { data?: { resumeFromPosition?: number } })?.data?.resumeFromPosition).toBe(
      expectedPos,
    );
  });
});

describe('reconstruction parity (M5 gate)', () => {
  it('openFromCheckpoint buildSessionContext deep-equals openFromBackend after a compaction', async () => {
    const backend = new BufferedRedisBackend(store);
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    const sid = sm.getSessionId();
    sids.push(sid);

    sm.appendMessage({ role: 'user', content: 'old turn 1' } as never);
    sm.appendMessage({ role: 'assistant', content: 'old answer 1' } as never);
    const firstKeptId = sm.appendMessage({ role: 'user', content: 'kept question' } as never);
    sm.appendMessage({ role: 'assistant', content: 'kept answer' } as never);
    sm.appendCompaction('summary of earlier turns', firstKeptId, 4321);
    await backend.flush();

    // Run the real extension to write the marker.
    const handlers: Record<string, Function> = {};
    const pi = {
      on: (ev: string, h: Function) => {
        handlers[ev] = h;
      },
    };
    checkpointExtension(store, sm)(pi as never);
    await handlers.session_compact({ compactionEntry: { firstKeptEntryId: firstKeptId } });
    await backend.flush();

    const viaCheckpoint = await SessionManager.openFromCheckpoint(sid, backend, process.cwd());
    const viaBackend = await SessionManager.openFromBackend(sid, backend, process.cwd());
    expect(viaCheckpoint.buildSessionContext()).toEqual(viaBackend.buildSessionContext());

    // And it really read a smaller slice than the full log.
    const cpMarker = await backend.latestCheckpoint(sid);
    const resumeFrom = (cpMarker as { data?: { resumeFromPosition?: number } }).data!
      .resumeFromPosition!;
    const tail = await store.read(sid, resumeFrom);
    const full = await store.read(sid);
    expect(tail.length).toBeLessThan(full.length);
  });
});

describe('openFromCheckpoint thinkingLevel reset (documented tail-load caveat)', () => {
  it('drops a pre-tail thinking_level_change: tail-load thinkingLevel is default, full-load is preserved', async () => {
    const backend = new BufferedRedisBackend(store);
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    const sid = sm.getSessionId();
    sids.push(sid);

    sm.appendThinkingLevelChange('medium'); // pre-tail (before firstKept)
    sm.appendMessage({ role: 'user', content: 'q' } as never);
    const firstKeptId = sm.appendMessage({ role: 'assistant', content: 'a' } as never);
    sm.appendMessage({ role: 'user', content: 'q2' } as never);
    sm.appendCompaction('summary', firstKeptId, 1);
    await backend.flush();

    const handlers: Record<string, Function> = {};
    const pi = {
      on: (ev: string, h: Function) => {
        handlers[ev] = h;
      },
    };
    checkpointExtension(store, sm)(pi as never);
    await handlers.session_compact({ compactionEntry: { firstKeptEntryId: firstKeptId } });
    await backend.flush();

    const viaBackend = await SessionManager.openFromBackend(sid, backend, process.cwd());
    const viaCheckpoint = await SessionManager.openFromCheckpoint(sid, backend, process.cwd());
    expect(viaBackend.buildSessionContext().thinkingLevel).toBe('medium'); // full load preserves
    expect(viaCheckpoint.buildSessionContext().thinkingLevel).toBe('off'); // tail load resets (documented)
  });
});
