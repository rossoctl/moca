import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdWatch, type WatchOptions } from '../src/subagent.js';
import { openLedger, type LedgerRecord } from '../src/core/subagent-ledger.js';
import { LeafTransport } from '../src/transport/leaf-turn.js';
import type { TurnEvent } from '../src/api/types.js';

function makeRt(scratch: string, events: TurnEvent[] = []) {
  const cp = {
    mintSessionToken: vi.fn(async () => ({ token: 'tok', expiresAt: 9 })),
    // The real client always has this; without it `cmdWatch` has no stream to read and these cases
    // would be exercising only the fallback path. An empty stream ENDS at once, which is what sends
    // `watch` down the sweep path these cases were written for.
    streamEvents: vi.fn(async function* () {
      for (const e of events) yield e;
    }),
  };
  const harness = { baseUrl: vi.fn(async () => 'https://harness.test') };
  // The poll loop sleeps on the runtime clock, so advancing it from `sleep` drives `watch`
  // without any real time passing.
  const clock = { ms: 1 };
  const sleep = vi.fn(async (ms: number) => {
    clock.ms += ms;
  });
  return {
    rt: {
      cp,
      harness,
      auth: { subject: 'alice', apiToken: 'x', expiresAt: 999 },
      paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
      now: () => clock.ms,
      sleep,
      fetchImpl: fetch,
    } as any,
    cp,
    sleep,
    clock,
  };
}

function makeIo(): { io: any; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

/** A transport whose `readLeafState` answers from a per-session queue, repeating the last entry. */
function queuedTransport(byId: Record<string, unknown[]>): LeafTransport {
  return {
    readLeafState: vi.fn(async (sid: string) => {
      const q = byId[sid];
      if (!q) throw new Error(`unexpected sid ${sid}`);
      return q.length > 1 ? q.shift() : q[0];
    }),
  } as unknown as LeafTransport;
}

const seedRecord = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  sessionId: 's1',
  envelope: { kind: 'prompt', prompt: 'p' },
  submittedAt: 1,
  lastKnownState: 'running',
  stateObservedAt: 1,
  ...over,
});

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'watch-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const base = (over: Partial<WatchOptions> = {}): WatchOptions => ({ json: false, ...over });

describe('cmdWatch', () => {
  it('says so and returns success when there is nothing to watch', async () => {
    const { rt, sleep } = makeRt(scratch);
    const { io, err, out } = makeIo();
    const r = await cmdWatch(rt, io, base({ transport: queuedTransport({}) }));
    expect(r).toBe(0);
    expect(err.join('\n')).toContain('no subagents');
    expect(out).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('prints a baseline line per row and exits without polling when every row is already final', async () => {
    const { rt, sleep } = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'a', lastKnownState: 'done' }));
    ledger.append(seedRecord({ sessionId: 'b', submittedAt: 2, lastKnownState: 'failed' }));
    const readLeafState = vi.fn();
    const { io, out } = makeIo();
    const r = await cmdWatch(
      rt,
      io,
      base({ ledger, transport: { readLeafState } as unknown as LeafTransport }),
    );
    expect(r).toBe(0);
    expect(readLeafState).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(out.join('')).toBe('done     a\nfailed   b\n');
  });

  it('emits one line per change and stops when the last row finishes', async () => {
    const { rt, sleep } = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'a', childPid: process.pid }));
    const transport = queuedTransport({
      // Two `queued` reads in a row must produce one `running` line, not two.
      a: ['queued', 'queued', { status: 'responded', text: 'hi' }],
    });
    const { io, out } = makeIo();
    const r = await cmdWatch(rt, io, base({ ledger, transport }));
    expect(r).toBe(0);
    expect(out).toEqual(['running  a\n', 'done     a\n']);
    expect(sleep).toHaveBeenCalledTimes(2);
    // The terminal state is persisted by the sweep, as `subagents` would have done.
    expect(openLedger(rt.paths.subagentsFile).find('a')!.lastKnownState).toBe('done');
  });

  it('ends the watch on a row that goes unknown, rather than polling forever', async () => {
    const { rt } = makeRt(scratch);
    // Well past the 60 s result-write grace, so a dead child with no record reads as `unknown`.
    rt.now = () => 10_000_000;
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    // Pid 2^31-1 is almost certainly not alive on any dev machine.
    ledger.append(seedRecord({ sessionId: 'gone', childPid: 0x7fffffff, stateObservedAt: 1 }));
    const { io, out } = makeIo();
    const r = await cmdWatch(
      rt,
      io,
      base({ ledger, transport: queuedTransport({ gone: ['queued'] }) }),
    );
    expect(r).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('unknown');
  });

  it('--json emits NDJSON, one event per line', async () => {
    const { rt } = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'a', tag: 'batch-1', label: 'audit' }));
    const transport = queuedTransport({ a: [{ status: 'paused', gateId: 0 }] });
    const { io, out } = makeIo();
    const r = await cmdWatch(rt, io, base({ json: true, ledger, transport }));
    expect(r).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!.trim())).toEqual({
      sessionId: 'a',
      tag: 'batch-1',
      label: 'audit',
      kind: 'prompt',
      state: 'paused',
      detail: 'gate requested',
      // A line the sweep produced carries no cursor (#392).
      cursor: null,
      at: 1,
    });
  });

  it('watches only the rows with the given --tag', async () => {
    const { rt } = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'mine', tag: 'parent-a', lastKnownState: 'done' }));
    ledger.append(seedRecord({ sessionId: 'theirs', submittedAt: 2, tag: 'other' }));
    const { io, out } = makeIo();
    const r = await cmdWatch(
      rt,
      io,
      base({ tag: 'parent-a', ledger, transport: queuedTransport({}) }),
    );
    expect(r).toBe(0);
    expect(out.join('')).toContain('mine');
    expect(out.join('')).not.toContain('theirs');
  });

  it('picks up a subagent spawned after the watch started', async () => {
    const { rt } = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'first', childPid: process.pid }));
    let reads = 0;
    const transport = {
      readLeafState: vi.fn(async () => {
        // The second spawn lands while `first` is still running, so the next tick picks it up.
        if (reads++ === 0) {
          ledger.append(
            seedRecord({ sessionId: 'second', submittedAt: 2, lastKnownState: 'done' }),
          );
          return 'queued';
        }
        return { status: 'responded', text: 'hi' };
      }),
    } as unknown as LeafTransport;
    const { io, out } = makeIo();
    const r = await cmdWatch(rt, io, base({ ledger, transport }));
    expect(r).toBe(0);
    expect(out.map((l) => l.trim())).toEqual([
      'running  first',
      'done     first',
      'done     second',
    ]);
  });

  it('reads an async row through the turn routes, never minting a session token', async () => {
    const { rt, cp } = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'a', turnId: 't1' }));
    const turns = {
      readTurnState: vi.fn(async () => ({ status: 'failed' as const, reason: 'lost' })),
    };
    const { io, out } = makeIo();
    const r = await cmdWatch(rt, io, base({ ledger, turns, transport: queuedTransport({}) }));
    expect(r).toBe(0);
    expect(cp.mintSessionToken).not.toHaveBeenCalled();
    expect(turns.readTurnState).toHaveBeenCalledWith('a', 't1', undefined);
    expect(out.join('')).toBe('failed   a  (lost)\n');
  });

  it('Ctrl-C during a sweep ends the watch with 130, recording nothing', async () => {
    const { rt } = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'a', childPid: process.pid }));
    const controller = new AbortController();
    const transport = {
      // What an aborted fetch does: the read rejects, so the row would otherwise read `unknown`.
      readLeafState: vi.fn(async () => {
        controller.abort();
        throw new Error('This operation was aborted');
      }),
    } as unknown as LeafTransport;
    const { io, out } = makeIo();
    const r = await cmdWatch(rt, io, base({ ledger, transport, signal: controller.signal }));
    expect(r).toBe(130);
    expect(out).toEqual([]);
    expect(openLedger(rt.paths.subagentsFile).find('a')!.lastKnownState).toBe('running');
  });

  it('Ctrl-C between two polls ends the watch with 130', async () => {
    const { rt } = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'a', childPid: process.pid }));
    const controller = new AbortController();
    rt.sleep = vi.fn(async () => {
      controller.abort();
    });
    const { io, out } = makeIo();
    const r = await cmdWatch(
      rt,
      io,
      base({ ledger, transport: queuedTransport({ a: ['queued'] }), signal: controller.signal }),
    );
    expect(r).toBe(130);
    expect(out).toEqual(['running  a\n']);
  });
});
