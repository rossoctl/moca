// The seams between the detachable-turn tasks (#471 final review): resume, Esc, and restart flows
// end to end, through the real HarnessClient where the wire bytes matter.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HarnessClient } from '../src/api/harness.js';
import { ActiveSession, type SessionEvent } from '../src/core/session-manager.js';
import { TranscriptStore } from '../src/core/transcripts.js';
import { fakeControlPlane } from './helpers/fakes.js';

const NOW = 1_000_000_000; // ms

const sse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

function session(fetchImpl: typeof fetch) {
  const slept: number[] = [];
  const s = new ActiveSession(
    {
      cp: fakeControlPlane(),
      harness: new HarnessClient('http://h', fetchImpl),
      now: () => NOW,
      sleep: async (ms) => void slept.push(ms),
      detachable: true,
    },
    's1',
    { token: 'st', expiresAt: 4_000_000_000 },
  );
  const events: SessionEvent[] = [];
  s.on((e) => events.push(e));
  return { session: s, slept, events, ends: () => events.filter((e) => e.kind === 'turn-end') };
}

describe('C1: resume after a finished turn', () => {
  it('a cursor at the terminal ends at once: attach-none, no re-attach, no error', async () => {
    // What GET /v1/turn sends when Last-Event-ID is the terminal's id: an ended turn frame, then EOF.
    const body =
      'id: t1:5-0\nevent: turn\ndata: {"type":"turn","turnId":"t1","sessionId":"s1","ended":true}\n\n';
    let calls = 0;
    const {
      session: s,
      slept,
      events,
      ends,
    } = session((async () => {
      calls++;
      return sse(body);
    }) as unknown as typeof fetch);
    const t0 = Date.now();
    s.attachExisting({ lastEventId: 't1:5-0', expectOpen: false });
    await s.idle();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    expect(events).toContainEqual({ kind: 'attach-none', missed: false });
    expect(ends()).toEqual([]);
    expect(s.runningDetachable).toBe(false);
  });

  it('records no second turn in the transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seams-'));
    const owner = { subject: 'u', controlPlaneUrl: 'http://cp' };
    const before = new TranscriptStore(dir, owner);
    before.appendPrompt('s1', 'go');
    before.appendFrame('s1', { type: 'turn', turnId: 't1', sessionId: 's1' }, 't1:1-0');
    before.appendFrame('s1', { type: 'done', sessionId: 's1', stopReason: 'stop' }, 't1:5-0');
    // A fresh process resumes: it loads the transcript, then attaches from its last id.
    const transcripts = new TranscriptStore(dir, owner);
    const t = transcripts.load('s1')!;
    const body =
      'id: t1:5-0\nevent: turn\ndata: {"type":"turn","turnId":"t1","sessionId":"s1","ended":true}\n\n';
    const s = new ActiveSession(
      {
        cp: fakeControlPlane(),
        harness: new HarnessClient('http://h', (async () => sse(body)) as unknown as typeof fetch),
        transcripts,
        now: () => NOW,
        sleep: async () => undefined,
        detachable: true,
      },
      's1',
      { token: 'st', expiresAt: 4_000_000_000 },
    );
    s.attachExisting({ lastEventId: t.lastEventId, expectOpen: false });
    await s.idle();
    const turns = readFileSync(join(dir, 's1.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"kind":"turn"'));
    expect(turns).toHaveLength(1);
  });
});
