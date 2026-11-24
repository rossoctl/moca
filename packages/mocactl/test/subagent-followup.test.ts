import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFollowUp, type FollowUpOptions } from '../src/subagent.js';
import { openLedger, type Ledger, type LedgerRecord } from '../src/core/subagent-ledger.js';
import type { LeafEnvelope, LeafResultBody } from '../src/transport/leaf-turn.js';

/* --- harness --- */

const DONE: LeafResultBody = { status: 'responded', text: 'the first answer\n' };

function makeRt(scratch: string) {
  const cp = {
    mintSessionToken: vi.fn(async () => ({ token: 'tok-xyz', expiresAt: 4_000_000_000 })),
  };
  const harness = { baseUrl: vi.fn(async () => 'https://harness.test') };
  return {
    rt: {
      cp,
      harness,
      auth: { subject: 'alice', apiToken: 'api-tok', expiresAt: 999 },
      endpoints: { harnessUrl: 'https://harness.test' },
      paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
      now: () => 2000,
      sleep: vi.fn(async () => {}),
      fetchImpl: fetch,
    } as any,
    cp,
  };
}

function makeIo(): { io: any; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

/** The sync result read, for a row with no turnId. */
function fakeTransport(body: LeafResultBody | 'queued') {
  return { readLeafState: vi.fn(async () => body) } as any;
}

function row(over: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    sessionId: 'sess-abc',
    envelope: { kind: 'prompt', prompt: 'do the thing' },
    submittedAt: 1,
    lastKnownState: 'done',
    stateObservedAt: 1,
    ...over,
  };
}

let scratch: string;
let ledger: Ledger;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'followup-'));
  ledger = openLedger(join(scratch, 'subagents.jsonl'), () => 2000);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const opts = (over: Partial<FollowUpOptions> = {}): FollowUpOptions => ({
  sessionId: 'sess-abc',
  prompt: 'and now the second thing',
  json: false,
  ledger,
  outDir: scratch,
  transport: fakeTransport(DONE),
  ...over,
});

/* --- refusals --- */

describe('cmdFollowUp — refusals', () => {
  it('refuses an empty prompt before anything is dispatched', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const forkFn = vi.fn(async () => 123);
    ledger.append(row());
    const r = await cmdFollowUp(rt, io, opts({ prompt: '   ', forkFn }));
    expect(r).toBe(2);
    expect(forkFn).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('non-empty prompt');
  });

  it('refuses a sessionId with no ledger row, naming where the envelope lives', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const forkFn = vi.fn(async () => 123);
    const r = await cmdFollowUp(rt, io, opts({ forkFn }));
    expect(r).toBe(1);
    expect(forkFn).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('machine that spawned it');
  });

  it('refuses a row that is still running, and says how to wait for it', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const forkFn = vi.fn(async () => 123);
    ledger.append(row({ lastKnownState: 'running', childPid: process.pid }));
    const r = await cmdFollowUp(rt, io, opts({ forkFn }));
    expect(r).toBe(1);
    expect(forkFn).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('mocactl get --wait sess-abc');
  });

  // A follow-up prompt is not an answer to a gate: dispatching one would leave the gate pending.
  it('refuses a row parked at a gate, and says to answer the gate instead', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const forkFn = vi.fn(async () => 123);
    ledger.append(row({ lastKnownState: 'paused' }));
    const r = await cmdFollowUp(rt, io, opts({ forkFn }));
    expect(r).toBe(1);
    expect(forkFn).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('mocactl approve sess-abc');
  });
});

/* --- the sync path --- */

describe('cmdFollowUp — a sync row', () => {
  it('copies the previous result out BEFORE dispatching the new turn', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const resultFile = join(scratch, 'sess-abc.text');
    // Asserted inside the fork: the copy is worthless if it lands after the overwriting turn.
    const forkFn = vi.fn(async () => {
      expect(existsSync(resultFile)).toBe(true);
      return 4321;
    });
    ledger.append(row());
    const r = await cmdFollowUp(rt, io, opts({ forkFn }));
    expect(r).toBe(0);
    expect(forkFn).toHaveBeenCalledTimes(1);
    expect(readFileSync(resultFile, 'utf8')).toBe('the first answer\n');
    expect(err.join('\n')).toContain('wrote');
    expect(err.join('\n')).toContain('(pid 4321)');
  });

  it('forks a prompt envelope carrying the new text and the row’s workload context', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io } = makeIo();
    let sent: LeafEnvelope | undefined;
    const forkFn = vi.fn(async (_s: string, _t: string, env: LeafEnvelope) => {
      sent = env;
      return 4321;
    });
    ledger.append(
      row({
        envelope: {
          kind: 'prompt',
          prompt: 'do the thing',
          configRef: `sha256:${'a'.repeat(64)}`,
          workloadId: 'wl-1',
          contextWritable: true,
        },
        workloadId: 'wl-1',
      }),
    );
    const r = await cmdFollowUp(rt, io, opts({ forkFn }));
    expect(r).toBe(0);
    expect(cp.mintSessionToken).toHaveBeenCalledWith('sess-abc');
    expect(sent).toEqual({
      sessionId: 'sess-abc',
      kind: 'prompt',
      prompt: 'and now the second thing',
      configRef: `sha256:${'a'.repeat(64)}`,
      workloadId: 'wl-1',
      contextWritable: true,
    });
  });

  // The session already holds the repo workspace, so a follow-up needs no --repo/--ref.
  it('follows up on a solve row as a prompt turn', async () => {
    const { rt } = makeRt(scratch);
    const { io } = makeIo();
    let sent: LeafEnvelope | undefined;
    const forkFn = vi.fn(async (_s: string, _t: string, env: LeafEnvelope) => {
      sent = env;
      return 4321;
    });
    ledger.append(
      row({
        envelope: {
          kind: 'solve',
          prompt: 'fix the bug',
          repoUrl: 'https://git.test/r',
          ref: 'main',
        },
        lastKnownState: 'done',
      }),
    );
    const r = await cmdFollowUp(rt, io, opts({ forkFn }));
    expect(r).toBe(0);
    expect(sent?.kind).toBe('prompt');
    expect(sent?.prompt).toBe('and now the second thing');
    expect(sent).not.toHaveProperty('repoUrl');
  });

  // The 24 h result record expires; that is not a reason to refuse the follow-up.
  it('continues when there is no previous result left to copy', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const forkFn = vi.fn(async () => 4321);
    ledger.append(row());
    const r = await cmdFollowUp(rt, io, opts({ forkFn, transport: fakeTransport('queued') }));
    expect(r).toBe(0);
    expect(forkFn).toHaveBeenCalledTimes(1);
    expect(err.join('\n')).toContain('no result to preserve');
  });

  it('replaces the ledger row so a later gate decision resends the follow-up text', async () => {
    const { rt } = makeRt(scratch);
    const { io } = makeIo();
    ledger.append(row({ tag: 'batch-7', label: 'first', childPid: 999 }));
    const r = await cmdFollowUp(rt, io, opts({ forkFn: async () => 4321 }));
    expect(r).toBe(0);
    const after = ledger.find('sess-abc')!;
    expect(after.envelope.prompt).toBe('and now the second thing');
    expect(after.lastKnownState).toBe('running');
    expect(after.childPid).toBe(4321);
    // Caller-side labels survive the replacement: it is the same subagent, on its second turn.
    expect(after.tag).toBe('batch-7');
    expect(after.label).toBe('first');
    expect(after.submittedAt).toBe(2000);
  });
});

/* --- the async path --- */

describe('cmdFollowUp — an async row', () => {
  it('submits a new turn, forks nothing, and does not copy a result', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const transport = fakeTransport(DONE);
    const turns = { submit: vi.fn(async () => 't-second') };
    const forkFn = vi.fn(async () => 4321);
    ledger.append(row({ turnId: 't-first' }));
    const r = await cmdFollowUp(rt, io, opts({ turns, transport, forkFn }));
    expect(r).toBe(0);
    expect(forkFn).not.toHaveBeenCalled();
    // Each async turn keeps its own artifacts (#840), so nothing is overwritten and nothing is read.
    expect(transport.readLeafState).not.toHaveBeenCalled();
    expect(existsSync(join(scratch, 'sess-abc.text'))).toBe(false);
    expect(err.join('\n')).toContain('(turn t-second)');
    const after = ledger.find('sess-abc')!;
    expect(after.turnId).toBe('t-second');
    expect(after.childPid).toBeUndefined();
    expect(after.lastKnownState).toBe('running');
  });

  it('--json reports the new turn and the files it copied', async () => {
    const { rt } = makeRt(scratch);
    const { io, out } = makeIo();
    ledger.append(row({ turnId: 't-first' }));
    const r = await cmdFollowUp(
      rt,
      io,
      opts({ json: true, turns: { submit: vi.fn(async () => 't-second') } }),
    );
    expect(r).toBe(0);
    expect(JSON.parse(out[0]!.trim())).toEqual({
      type: 'session',
      sessionId: 'sess-abc',
      turnId: 't-second',
      files: [],
    });
  });

  it('refuses when the submission fails, leaving the row as it was', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const turns = {
      submit: vi.fn(async () => {
        throw new Error('control plane said no');
      }),
    };
    ledger.append(row({ turnId: 't-first' }));
    const r = await cmdFollowUp(rt, io, opts({ turns }));
    expect(r).toBe(1);
    expect(err.join('\n')).toContain('control plane said no');
    const after = ledger.find('sess-abc')!;
    expect(after.turnId).toBe('t-first');
    expect(after.envelope.prompt).toBe('do the thing');
  });
});
