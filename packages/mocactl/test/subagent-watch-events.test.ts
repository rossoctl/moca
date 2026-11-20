import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdWatch, type WatchOptions } from '../src/subagent.js';
import { openLedger, type LedgerRecord } from '../src/core/subagent-ledger.js';
import { LeafTransport, type LeafResultBody } from '../src/transport/leaf-turn.js';
import { ApiError } from '../src/api/errors.js';
import type { TurnEvent } from '../src/api/types.js';

/**
 * The same fixture `subagent-watch.test.ts` uses — a mkdtemp scratch dir, a fake clock driven from
 * `sleep`, and `rt.cp` as a hand-written object — with the control plane's stream supplied per case.
 */
function makeRt(scratch: string, cp: Record<string, unknown>) {
  const clock = { ms: 1 };
  const sleep = vi.fn(async (ms: number) => {
    clock.ms += ms;
  });
  return {
    rt: {
      cp: { mintSessionToken: vi.fn(async () => ({ token: 'tok', expiresAt: 9 })), ...cp },
      harness: { baseUrl: vi.fn(async () => 'https://harness.test') },
      auth: { subject: 'alice', apiToken: 'x', expiresAt: 999 },
      paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
      now: () => clock.ms,
      sleep,
      fetchImpl: fetch,
    } as any,
    sleep,
    clock,
  };
}

function makeIo(): { io: any; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

/**
 * A stream that yields `events` and then ends, recording the `since` it was opened with.
 *
 * The `since` is recorded by the CALL, not by the generator's body: an async generator runs nothing
 * until its first `next()`, so a stream that is opened and then never drained -- which is what a
 * reopen on the sweep that ends the watch is -- would otherwise record nothing.
 */
function fakeStream(events: TurnEvent[], gap?: string) {
  const opened: (string | undefined)[] = [];
  const frames = async function* (opts: {
    onGap?: (s: string) => void;
  }): AsyncGenerator<TurnEvent> {
    if (gap !== undefined) opts.onGap?.(gap);
    for (const e of events) yield e;
  };
  return {
    opened,
    streamEvents: (
      opts: { since?: string; onGap?: (s: string) => void } = {},
    ): AsyncGenerator<TurnEvent> => {
      opened.push(opts.since);
      return frames(opts);
    },
  };
}

const ev = (over: Partial<TurnEvent>): TurnEvent => ({
  cursor: '1-0',
  ts: 1,
  sessionId: 's-1',
  turnId: 't-1',
  state: 'queued',
  attempts: 0,
  ...over,
});

const seedRecord = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  sessionId: 's-1',
  envelope: { kind: 'prompt', prompt: 'p' },
  submittedAt: 1,
  lastKnownState: 'running',
  stateObservedAt: 1,
  turnId: 't-1',
  ...over,
});

/** A sweep that can never finish a row on its own, so every terminal line comes from the stream. */
const neverFinishes = { readTurnState: vi.fn(async () => 'queued' as const) };

/**
 * A sweep whose FIRST read is non-terminal: the baseline sweep has to leave the row running, or
 * `watch` returns before it ever reads the stream and the case proves nothing.
 */
function queuedThen(body: LeafResultBody) {
  let reads = 0;
  return { readTurnState: vi.fn(async () => (reads++ === 0 ? ('queued' as const) : body)) };
}

const base = (over: Partial<WatchOptions> = {}): WatchOptions => ({
  json: true,
  turns: neverFinishes,
  transport: { readLeafState: vi.fn() } as unknown as LeafTransport,
  ...over,
});

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'watch-ev-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const parsed = (out: string[]) => out.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('watch over the event stream (#392)', () => {
  it('prints one line per reported state change, from the stream rather than a sweep', async () => {
    const stream = fakeStream([
      ev({ cursor: '1-0', state: 'queued' }),
      ev({ cursor: '2-0', state: 'running' }),
      ev({ cursor: '3-0', state: 'solved' }),
    ]);
    const { rt } = makeRt(scratch, stream);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord());
    const { io, out } = makeIo();

    expect(await cmdWatch(rt, io, base({ ledger }))).toBe(0);
    // Three events, two lines: `queued` and `running` are both honestly `running`, so they collapse
    // into the baseline's own line. The terminal can only have come from the stream — the sweep
    // answers `queued` forever.
    expect(parsed(out).map((l) => [l.state, l.detail])).toEqual([
      ['running', null],
      ['done', null],
    ]);
    // Every line carries the cursor of the event that produced it, so a caller can store it; a line
    // the sweep produced carries none.
    expect(parsed(out).map((l) => l.cursor)).toEqual([null, '3-0']);
    expect(stream.opened).toEqual([undefined]);
    // And the stream's terminal is persisted, as the sweep would have persisted its own.
    expect(openLedger(rt.paths.subagentsFile).find('s-1')!.lastKnownState).toBe('done');
  });

  it('opens the stream at the cursor `--since` gives it', async () => {
    const stream = fakeStream([ev({ cursor: '9-0', state: 'solved' })]);
    const { rt } = makeRt(scratch, stream);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord());
    const { io, out } = makeIo();
    expect(await cmdWatch(rt, io, base({ ledger, since: '7-0' }))).toBe(0);
    expect(stream.opened).toEqual(['7-0']);
    expect(parsed(out).at(-1)).toMatchObject({ state: 'done', cursor: '9-0' });
  });

  it("ignores another session's events and events for a different turn of the same session", async () => {
    const stream = fakeStream([
      ev({ cursor: '1-0', sessionId: 's-other', state: 'solved' }),
      ev({ cursor: '2-0', turnId: 't-other', state: 'solved' }),
      ev({ cursor: '3-0', state: 'solved' }),
    ]);
    const { rt } = makeRt(scratch, stream);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord());
    const { io, out } = makeIo();
    expect(await cmdWatch(rt, io, base({ ledger }))).toBe(0);
    // A row only ends on ITS turn's terminal event: the first two produce nothing at all.
    expect(parsed(out).map((l) => [l.sessionId, l.state, l.cursor])).toEqual([
      ['s-1', 'running', null],
      ['s-1', 'done', '3-0'],
    ]);
  });

  it('advances the cursor over skipped events, so a reopen replays none of them', async () => {
    // One subject's log carries all their work. A cursor that only moved over this `watch`'s own
    // rows would re-read every foreign event on each reopen -- harmless but unbounded by the log's
    // own length, and the reason to advance before the filter rather than after it.
    const stream = fakeStream([
      ev({ cursor: '1-0', sessionId: 's-other', state: 'running' }),
      ev({ cursor: '2-0', sessionId: 's-other', state: 'solved' }),
    ]);
    const { rt } = makeRt(scratch, stream);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord());
    const { io, out } = makeIo();
    expect(await cmdWatch(rt, io, base({ ledger, turns: queuedThen({ status: 'solved' }) }))).toBe(
      0,
    );
    expect(stream.opened).toEqual([undefined, '2-0']);
    expect(parsed(out).map((l) => l.state)).toEqual(['running', 'done']);
  });

  it('prints no second line when the safety-net sweep re-reads a state the stream reported', async () => {
    const stream = fakeStream([ev({ cursor: '1-0', state: 'solved' })]);
    const { rt } = makeRt(scratch, stream);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord());
    const { io, out } = makeIo();
    // The stream reports `solved`; the sweep that follows reads the same terminal turn. The second
    // `done` is not a transition, and the dedup is what makes the two sources coexist.
    expect(await cmdWatch(rt, io, base({ ledger, turns: queuedThen({ status: 'solved' }) }))).toBe(
      0,
    );
    expect(parsed(out).map((l) => l.state)).toEqual(['running', 'done']);
    expect(parsed(out).at(-1)!.cursor).toBe('1-0');
  });

  it('falls back to sweeping when the stream is unavailable, keeping the #381 behaviour', async () => {
    // An older control plane has no `/v1/events`. That is not an error — it is the old behaviour.
    const cp = {
      streamEvents: async function* (): AsyncGenerator<TurnEvent> {
        throw new ApiError('control-plane', 404, 'not_found');
      },
    };
    const { rt } = makeRt(scratch, cp);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord());
    const { io, out } = makeIo();
    expect(await cmdWatch(rt, io, base({ ledger, turns: queuedThen({ status: 'solved' }) }))).toBe(
      0,
    );
    expect(parsed(out).map((l) => [l.state, l.cursor])).toEqual([
      ['running', null],
      ['done', null],
    ]);
  });

  it('reports a sync (non-async) row from the sweep even with the stream running', async () => {
    // A row with a childPid and no turnId: a synchronous `spawn` produces NO turn and therefore no
    // events at all. This is why the sweep stays.
    const stream = fakeStream([]);
    const { rt } = makeRt(scratch, stream);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ turnId: undefined, childPid: process.pid }));
    const transport = {
      readLeafState: vi.fn(async () => ({ status: 'responded', text: 'hi' })),
    } as unknown as LeafTransport;
    const { io, out } = makeIo();
    expect(await cmdWatch(rt, io, base({ ledger, transport }))).toBe(0);
    expect(parsed(out)).toEqual([expect.objectContaining({ state: 'done', cursor: null })]);
  });

  it('notes a gap on stderr and recovers from the sweep', async () => {
    const stream = fakeStream([], '0-0');
    const { rt } = makeRt(scratch, stream);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord());
    const { io, out, err } = makeIo();
    expect(await cmdWatch(rt, io, base({ ledger, turns: queuedThen({ status: 'solved' }) }))).toBe(
      0,
    );
    expect(err.join('')).toContain('missed');
    expect(parsed(out).map((l) => l.state)).toEqual(['running', 'done']);
  });

  it('returns 130 on an abort while the stream is open', async () => {
    const controller = new AbortController();
    // A stream that aborts and then never yields: the signal, not an event, ends this watch.
    const cp = {
      streamEvents: async function* (): AsyncGenerator<TurnEvent> {
        controller.abort();
        await new Promise(() => {});
      },
    };
    const { rt } = makeRt(scratch, cp);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord());
    const { io, out } = makeIo();
    expect(await cmdWatch(rt, io, base({ ledger, signal: controller.signal }))).toBe(130);
    // The baseline sweep's line, and nothing after it: a Ctrl-C reports no new state.
    expect(parsed(out).map((l) => l.state)).toEqual(['running']);
  });
});
