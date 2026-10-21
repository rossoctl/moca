import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdSubagents, type SubagentsOptions } from '../src/subagent.js';
import { openLedger, type LedgerRecord } from '../src/core/subagent-ledger.js';
import { LeafTransport } from '../src/transport/leaf-turn.js';

function makeRt(scratch: string) {
  const cp = { mintSessionToken: vi.fn(async () => ({ token: 'tok', expiresAt: 9 })) };
  const harness = { baseUrl: vi.fn(async () => 'https://harness.test') };
  return {
    cp,
    harness,
    auth: { subject: 'alice', apiToken: 'x', expiresAt: 999 },
    paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
    now: () => 10_000,
    fetchImpl: fetch,
  } as any;
}

function makeIo(): { io: any; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

function fakeTransport(resps: Record<string, any>): LeafTransport {
  return {
    readLeafState: vi.fn(async (sid: string) => {
      if (!(sid in resps)) throw new Error('unexpected sid');
      return resps[sid];
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
  scratch = mkdtempSync(join(tmpdir(), 'subagents-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const base = (over: Partial<SubagentsOptions> = {}): SubagentsOptions => ({
  json: false,
  ...over,
});

/* --- empty state --- */

describe('cmdSubagents — empty state', () => {
  it("prints a 'no subagents' message to stderr and returns success (not an error)", async () => {
    const rt = makeRt(scratch);
    const { io, err } = makeIo();
    const r = await cmdSubagents(rt, io, base({ transport: fakeTransport({}) }));
    expect(r).toBe(0);
    expect(err.join('\n')).toContain('no subagents');
  });

  it('--json empty case emits {"subagents":[]} on stdout', async () => {
    const rt = makeRt(scratch);
    const { io, out } = makeIo();
    const r = await cmdSubagents(rt, io, base({ json: true, transport: fakeTransport({}) }));
    expect(r).toBe(0);
    expect(JSON.parse(out[0]!.trim())).toEqual({ subagents: [] });
  });
});

/* --- state resolution across the ledger + /runs/status join --- */

describe('cmdSubagents — joined view', () => {
  it("'running' + alive pid → honest 'running'; persisted", async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'alive', childPid: process.pid }));
    const transport = fakeTransport({ alive: 'queued' });
    const { io, out } = makeIo();
    const r = await cmdSubagents(rt, io, base({ json: true, ledger, transport }));
    expect(r).toBe(0);
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.subagents).toHaveLength(1);
    expect(parsed.subagents[0]).toMatchObject({ sessionId: 'alive', state: 'running' });
  });

  it("resolves 'queued' + dead child past grace to 'unknown', not left as 'queued'", async () => {
    // Set `now` to well past the stateObservedAt + grace window so the dead-child branch is
    // reached (DEFAULT_UNKNOWN_GRACE_MS is 60s; use a 10 000 000ms gap to be unambiguous).
    const rt = makeRt(scratch);
    rt.now = () => 10_000_000;
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    // Pid 2^31-1 is almost certainly not alive on any dev machine.
    ledger.append(seedRecord({ sessionId: 'gone', childPid: 0x7fffffff, stateObservedAt: 1 }));
    const transport = fakeTransport({ gone: 'queued' });
    const { io, out } = makeIo();
    const r = await cmdSubagents(rt, io, base({ json: true, ledger, transport }));
    expect(r).toBe(0);
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.subagents[0].state).toBe('unknown');
  });

  it('passes through responded/done/solved as honest "done"', async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'd1', envelope: { kind: 'prompt', prompt: 'p' } }));
    const transport = fakeTransport({ d1: { status: 'solved', patch: 'diff\n' } });
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, ledger, transport }));
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.subagents[0].state).toBe('done');
  });

  it("filters by --tag so a parent agent's own subagents are reportable in isolation", async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'mine', tag: 'parent-a', childPid: process.pid }));
    ledger.append(seedRecord({ sessionId: 'theirs', tag: 'other', childPid: process.pid }));
    const transport = fakeTransport({ mine: 'queued', theirs: 'queued' });
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, tag: 'parent-a', ledger, transport }));
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.subagents.map((s: any) => s.sessionId)).toEqual(['mine']);
  });

  it('one row failing to read status does not break the rest', async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'ok', childPid: process.pid }));
    ledger.append(seedRecord({ sessionId: 'bad', submittedAt: 2, childPid: process.pid }));
    const transport = {
      readLeafState: vi.fn(async (sid: string) => {
        if (sid === 'bad') throw new Error('status read failed');
        return { status: 'responded', text: 'done' };
      }),
    } as unknown as LeafTransport;
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, ledger, transport }));
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.subagents.map((s: any) => [s.sessionId, s.state])).toEqual([
      ['ok', 'done'],
      ['bad', 'unknown'],
    ]);
  });

  it('non-JSON output is an aligned table with a header row', async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 's1', tag: 'tag-a', bundle: 'sha256:'.padEnd(71, 'a') }));
    const transport = fakeTransport({ s1: { status: 'responded', text: 'ok' } });
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ ledger, transport }));
    const stdout = out.join('');
    const lines = stdout.split('\n').filter(Boolean);
    expect(lines[0]).toContain('SESSION');
    expect(lines[0]).toContain('LABEL');
    expect(lines[0]).toContain('STATE');
    // At least one data row.
    expect(lines[1]).toContain('s1');
    expect(lines[1]).toContain('done');
  });
});

describe('cmdSubagents — terminal rows are not re-queried (24h TTL safety)', () => {
  it('skips /runs/status for terminal rows (preserves ledger state past the TTL)', async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'done-row', lastKnownState: 'done' }));
    // readLeafState would REGRESS the row to 'unknown' if called (24h-aged session returns 404).
    // Pin that we do not call it at all.
    const readLeafState = vi.fn();
    const transport = { readLeafState } as unknown as LeafTransport;
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, ledger, transport }));
    expect(readLeafState).not.toHaveBeenCalled();
    expect(rt.cp.mintSessionToken).not.toHaveBeenCalled();
    expect(JSON.parse(out[0]!.trim()).subagents[0].state).toBe('done');
  });

  it("same guard applies to 'failed' and 'paused' rows (any terminal state)", async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'f', lastKnownState: 'failed', stateDetail: 'boom' }));
    ledger.append(seedRecord({ sessionId: 'p', submittedAt: 2, lastKnownState: 'paused' }));
    const readLeafState = vi.fn();
    const transport = { readLeafState } as unknown as LeafTransport;
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, ledger, transport }));
    expect(readLeafState).not.toHaveBeenCalled();
    const parsed = JSON.parse(out[0]!.trim());
    expect(
      parsed.subagents.map((s: { sessionId: string; state: string }) => [s.sessionId, s.state]),
    ).toEqual([
      ['f', 'failed'],
      ['p', 'paused'],
    ]);
    // The 'failed' detail from the ledger must survive — this is the whole point of not re-querying.
    expect(parsed.subagents[0].detail).toBe('boom');
  });
});

describe('cmdSubagents — workload', () => {
  it('reports the workload a row ran on, and null for one without', async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'w', workloadId: 'demo', lastKnownState: 'done' }));
    ledger.append(seedRecord({ sessionId: 'n', submittedAt: 2, lastKnownState: 'done' }));
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, ledger, transport: {} as LeafTransport }));
    const rows = JSON.parse(out[0]!.trim()).subagents;
    expect(rows.map((r: { workload: string | null }) => r.workload)).toEqual(['demo', null]);
  });

  it('shows writable only on rows that had a writable copy', async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(
      seedRecord({ sessionId: 'w', workloadId: 'demo', writable: true, lastKnownState: 'done' }),
    );
    ledger.append(
      seedRecord({ sessionId: 'r', workloadId: 'demo', submittedAt: 2, lastKnownState: 'done' }),
    );
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, ledger, transport: {} as LeafTransport }));
    const [writable, readOnly] = JSON.parse(out[0]!.trim()).subagents;
    expect(writable).toMatchObject({ sessionId: 'w', workload: 'demo', writable: true });
    expect(readOnly).not.toHaveProperty('writable');
    expect(Object.keys(readOnly)).toEqual([
      'sessionId',
      'tag',
      'kind',
      'state',
      'detail',
      'bundle',
      'workload',
      'submittedAt',
    ]);
  });
});

describe('cmdSubagents — label', () => {
  it('surfaces label on rows that have one, omits it on rows that do not', async () => {
    const rt = makeRt(scratch);
    const ledger = openLedger(rt.paths.subagentsFile, rt.now);
    ledger.append(seedRecord({ sessionId: 'l', label: 'diagnose', lastKnownState: 'done' }));
    ledger.append(seedRecord({ sessionId: 'n', submittedAt: 2, lastKnownState: 'done' }));
    const { io, out } = makeIo();
    await cmdSubagents(rt, io, base({ json: true, ledger, transport: {} as LeafTransport }));
    const [labelled, unlabelled] = JSON.parse(out[0]!.trim()).subagents;
    expect(labelled).toMatchObject({ sessionId: 'l', label: 'diagnose' });
    expect(unlabelled).not.toHaveProperty('label');
  });
});
