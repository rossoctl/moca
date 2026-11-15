import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ExecAbortedError,
  ExecMachineryError,
  ExecRefusedError,
  ProcessError,
  SandboxExecConn,
  type Exec,
  type ExecResult,
  type ProcessCall,
} from '../src/exec-conn.js';
import { LeaseEvent, SandboxMode } from '../src/gen/sandbox/v1/sandbox.js';
import { LeaseControlError, type LeaseStatusView } from '../src/lease.js';
import {
  MCP_INSTRUCTIONS,
  TOKEN_EXPIRED_TEXT,
  createSandboxMcpServer,
  execFailureText,
  type CallRecord,
  type SandboxMcpOptions,
  line,
  sandboxRules,
} from '../src/mcp-server.js';
import { PI_SCHEMAS } from '../src/schemas.js';
import { LEASE_PROCESSES_RULE, LEASE_RULE } from '../src/tools.js';
import { fakeExecRelay, type FakeExecAnswer } from './helpers/fake-relay.js';

const res = (over: Partial<ExecResult> = {}): ExecResult => ({
  stdout: Buffer.from('ok\n'),
  stderr: Buffer.alloc(0),
  exitCode: 0,
  truncated: false,
  lease: [],
  ...over,
});
const NO_LEASE: LeaseStatusView = {
  mode: 'per-exec',
  epochKnown: false,
  state: 'none',
  ageMs: 0,
  idleTimeoutS: 0,
};
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function connect(over: Partial<SandboxMcpOptions> & { exec: Exec }) {
  const records: CallRecord[] = [];
  const server = createSandboxMcpServer({
    info: async () => 'template default',
    lease: async () => NO_LEASE,
    record: (r) => records.push(r),
    ...over,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  closers.push(() => client.close());
  return { client, records, server };
}
type Res = { content: { text: string }[]; isError?: boolean };
const call = (c: Client, name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
  c.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined) as Promise<Res>;
const text = (r: Res) => r.content.map((x) => x.text).join('');
const throwing =
  (err: unknown): Exec =>
  async () => {
    throw err;
  };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** mocactl's ApiError, structurally: the server must not import mocactl. */
class FakeApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

describe('the sandbox MCP server (SBX0 §6.4)', () => {
  it('lists the nine tools with their schemas and the sandbox rules', async () => {
    const { client } = await connect({ exec: async () => res() });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'grep',
      'find',
      'ls',
      'sandbox_info',
      'reset',
    ]);
    expect(tools[0]!.inputSchema).toMatchObject({ type: 'object', required: ['command'] });
    // Pi's JSON Schemas go over the wire as they are: no zod, no conversion.
    for (const name of ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls'] as const) {
      expect(tools.find((t) => t.name === name)!.inputSchema).toEqual(
        JSON.parse(JSON.stringify(PI_SCHEMAS[name])),
      );
    }
    expect(tools[7]!.inputSchema).toMatchObject({ type: 'object' });
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    expect(client.getInstructions()).toMatch(/fresh VM/);
    expect(client.getServerVersion()).toMatchObject({ name: 'moca-sandbox' });
  });

  it('puts a non-default workspace in its instructions', async () => {
    const { client } = await connect({ exec: async () => res(), workspace: '/srv/ws' });
    expect(client.getInstructions()).toMatch(/\/srv\/ws/);
    expect(client.getInstructions()).not.toMatch(/\/workspace/);
  });

  it('runs a tool and records one Exec', async () => {
    const { client, records } = await connect({ exec: async () => res() });
    const r = await call(client, 'bash', { command: 'echo ok' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('ok\n');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tool: 'bash', execs: 1, ok: true });
    expect(records[0]!.error).toBeUndefined();
    expect(records[0]!.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(records[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  it('answers the call even when the recorder throws', async () => {
    const { client } = await connect({
      exec: async () => res(),
      record: () => {
        throw new Error('ENOSPC');
      },
    });
    const r = await call(client, 'bash', { command: 'echo ok' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('ok\n');
  });

  it("counts edit's two Execs and sandbox_info's none", async () => {
    let n = 0;
    const exec: Exec = async (_c, o) =>
      n++ === 0 ? res({ stdout: Buffer.from('a b\n') }) : (expect(o?.stdin).toBeDefined(), res());
    const { client, records } = await connect({ exec });
    const r = await call(client, 'edit', { path: 'f', edits: [{ oldText: 'a', newText: 'c' }] });
    expect(r.isError).toBeFalsy();
    await call(client, 'sandbox_info', {});
    expect(records).toMatchObject([
      { tool: 'edit', execs: 2, ok: true },
      { tool: 'sandbox_info', execs: 0, ok: true },
    ]);
  });

  it("keeps a command's non-zero exit as the tool's own error text", async () => {
    const { client, records } = await connect({
      exec: async () => res({ exitCode: 1, stdout: Buffer.from('FAIL\n') }),
    });
    const r = await call(client, 'bash', { command: 'pytest' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('FAIL\n\n\nCommand exited with code 1');
    expect(records[0]).toMatchObject({ ok: false, execs: 1 });
    expect(records[0]!.error).toBeUndefined(); // never the command's output
  });

  describe('maps every failure that is not the command to its own tool error (R4)', () => {
    const rows: Array<[string, unknown, string | RegExp]> = [
      [
        'a machinery failure says it is not the command output',
        new ExecMachineryError('sandbox failure: vm boot failed', 13),
        "sandbox failure, not your command's output: vm boot failed",
      ],
      [
        "the relay's in-flight cap (RESOURCE_EXHAUSTED)",
        new ExecMachineryError('sandbox busy: 4 Execs already in flight', 8, 'busy'),
        'sandbox busy: another client of this sandbox has Execs in flight; retry later',
      ],
      [
        "a saturated template's worker",
        new ExecMachineryError('template busy: busy: queue full', 2, 'template_busy'),
        'template busy; retry later',
      ],
      [
        'a memory-budget refusal',
        new ExecMachineryError('template busy: memory-budget: 8GiB', 2, 'template_busy'),
        'template busy; retry later',
      ],
      [
        'the relay cancelling at the token expiry',
        new ExecMachineryError(
          'sandbox token expired during the Exec: the command outlived its sandbox token and was cancelled',
          4,
          'token_expired',
        ),
        /^the sandbox token expired during the command, so the relay cancelled it/,
      ],
      [
        'UNAUTHENTICATED twice',
        new ExecRefusedError('exec authentication failed (after one token refresh)', 16),
        'the sandbox refused the call (exec authentication failed (after one token refresh)). ' +
          'If it expired or was deleted, run `mocactl sbx up` for a new one.',
      ],
      [
        'PERMISSION_DENIED',
        new ExecRefusedError('workspace not owned by this sandbox', 7),
        'the sandbox refused the call (workspace not owned by this sandbox). ' +
          'If it expired or was deleted, run `mocactl sbx up` for a new one.',
      ],
      [
        'a deleted sandbox, from the token source',
        new FakeApiError('sandbox_terminated', 'sandbox was deleted'),
        'sandbox was deleted; run `mocactl sbx up` for a new one',
      ],
      [
        'an expired sandbox, from the token source, with no known expiry',
        new FakeApiError('sandbox_terminated', 'sandbox has expired'),
        'sandbox expired; run `mocactl sbx up` for a new one',
      ],
      [
        'any other error',
        new Error('connect ECONNREFUSED 127.0.0.1:443'),
        'sandbox unavailable: connect ECONNREFUSED 127.0.0.1:443',
      ],
      ['a thrown non-Error', 'boom', 'sandbox unavailable: boom'],
    ];
    for (const [what, err, want] of rows) {
      it(what, async () => {
        const { client, records } = await connect({ exec: throwing(err) });
        const r = await call(client, 'bash', { command: 'ls' });
        expect(r.isError).toBe(true);
        if (typeof want === 'string') expect(text(r)).toBe(want);
        else expect(text(r)).toMatch(want);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ tool: 'bash', execs: 1, ok: false, error: text(r) });
      });
    }

    it('names the expiry date of an expired sandbox when it is known', async () => {
      const at = Date.UTC(2026, 9, 17, 12, 30) / 1000;
      const { client } = await connect({
        exec: throwing(new FakeApiError('sandbox_terminated', 'sandbox has expired')),
        expiresAt: at,
      });
      expect(text(await call(client, 'read', { path: 'a' }))).toBe(
        'sandbox expired on 2026-10-17T12:30:00.000Z; run `mocactl sbx up` for a new one',
      );
    });

    it('says the sandbox was deleted even when its expiry is known', async () => {
      const { client } = await connect({
        exec: throwing(new FakeApiError('sandbox_terminated', 'sandbox was deleted')),
        expiresAt: 2_000_000_000,
      });
      expect(text(await call(client, 'ls', {}))).toBe(
        'sandbox was deleted; run `mocactl sbx up` for a new one',
      );
    });

    it("reads a terminated error's reason field when it has one", async () => {
      const err = Object.assign(new Error('gone'), {
        code: 'sandbox_terminated',
        reason: 'deleted',
      });
      const { client } = await connect({ exec: throwing(err) });
      expect(text(await call(client, 'ls', {}))).toBe(
        'sandbox was deleted; run `mocactl sbx up` for a new one',
      );
    });

    it('maps a terminated sandbox in sandbox_info too', async () => {
      const { client, records } = await connect({
        exec: async () => res(),
        info: async () => {
          throw new FakeApiError('sandbox_terminated', 'sandbox was deleted');
        },
      });
      const r = await call(client, 'sandbox_info', {});
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('sandbox was deleted; run `mocactl sbx up` for a new one');
      expect(records[0]).toMatchObject({ tool: 'sandbox_info', execs: 0, ok: false });
    });

    it('keeps the record error to one line', async () => {
      const { client, records } = await connect({
        exec: throwing(new ExecMachineryError('sandbox failure: worker gone\n  at line 2\n', 14)),
      });
      await call(client, 'bash', { command: 'ls' });
      expect(records[0]!.error).toBe(
        "sandbox failure, not your command's output: worker gone at line 2",
      );
    });
  });

  it('maps input errors and unknown tools, sending nothing', async () => {
    const sent: string[] = [];
    const { client, records } = await connect({
      exec: async (c) => (sent.push(c), res()),
    });
    const bad = await call(client, 'bash', {});
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^invalid input: command is required/);
    const nope = await call(client, 'nope', {});
    expect(nope.isError).toBe(true);
    expect(text(nope)).toBe('unknown tool: nope');
    expect(sent).toEqual([]);
    expect(records).toMatchObject([
      { tool: 'bash', execs: 0, ok: false, error: expect.stringMatching(/^invalid input/) },
      { tool: 'nope', execs: 0, ok: false, error: 'unknown tool: nope' },
    ]);
  });

  it("refuses with 'sandbox busy' rather than queue past the wait, and never sends the refused call", async () => {
    let release!: () => void;
    const sent: string[] = [];
    let t = 1_000_000;
    const exec: Exec = async (command) => {
      sent.push(command);
      if (command === 'sleep 99') await new Promise<void>((r) => (release = r));
      return res();
    };
    const { client, records } = await connect({ exec, busyWaitMs: 50, now: () => t });
    const first = call(client, 'bash', { command: 'sleep 99' });
    await sleep(20);
    t += 192_000;
    const second = await call(client, 'bash', { command: 'echo next' });
    expect(second.isError).toBe(true);
    expect(text(second)).toBe(
      'sandbox busy: `sleep 99` has been running for 3m12s; retry later or wait for it',
    );
    expect(sent).toEqual(['sleep 99']);
    const info = await call(client, 'sandbox_info', {});
    expect(text(info)).toMatch(/^template default\n/); // costs no VM: never queued
    release();
    expect((await first).isError).toBeFalsy();
    expect(text(await call(client, 'bash', { command: 'echo after' }))).toBe('ok\n');
    expect(sent).toEqual(['sleep 99', 'echo after']);
    expect(records.map((r) => [r.tool, r.execs, r.ok])).toEqual([
      ['bash', 0, false],
      ['sandbox_info', 0, true],
      ['bash', 1, true],
      ['bash', 1, true],
    ]);
    // The agent is told which call it waited behind; the record keeps no command text.
    expect(records[0]!.error).toBe('sandbox busy (client-side): waited behind a running call');
    expect(JSON.stringify(records)).not.toContain('sleep 99');
  });

  it('does not queue a call whose signal was already aborted', async () => {
    // The MCP client never sends such a request, so this pins the queue itself: an abort listener
    // never fires for a signal that is already aborted, and the call must not wait for its turn.
    const q = line(60_000, () => 0);
    expect(await q.acquire('slow', new AbortController().signal)).toBe('go');
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    expect(await q.acquire('never', ac.signal)).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(1_000);
    q.release(); // nothing was queued behind 'slow'
    expect(await q.acquire('next', new AbortController().signal)).toBe('go');
  });

  it('names a running file tool by its tool and path, in seconds under a minute', async () => {
    let release!: () => void;
    let t = 0;
    const exec: Exec = async () => {
      await new Promise<void>((r) => (release = r));
      return res({ stdout: Buffer.from('x') });
    };
    const { client } = await connect({ exec, busyWaitMs: 30, now: () => t });
    const first = call(client, 'read', { path: 'src/a.ts' });
    await sleep(10);
    t += 45_400;
    expect(text(await call(client, 'ls', {}))).toBe(
      'sandbox busy: `read src/a.ts` has been running for 45s; retry later or wait for it',
    );
    release();
    await first;
  });

  it('cuts a long multi-line command to one line in the busy message', async () => {
    let release!: () => void;
    const exec: Exec = async () => {
      await new Promise<void>((r) => (release = r));
      return res();
    };
    const { client } = await connect({ exec, busyWaitMs: 30 });
    const long = `cd x &&\n  ${'y'.repeat(200)}`;
    const first = call(client, 'bash', { command: long });
    await sleep(10);
    const msg = text(await call(client, 'bash', { command: 'true' }));
    expect(msg).toMatch(/^sandbox busy: `cd x && y+…` has been running for 0s;/);
    expect(msg.split('`')[1]!.length).toBe(80);
    release();
    await first;
  });

  it('defaults the wait to 30 s (spec §6.4)', async () => {
    let release!: () => void;
    const timers: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const exec: Exec = async (command) => {
      if (command === 'sleep 99') await new Promise<void>((r) => (release = r));
      return res();
    };
    const { client } = await connect({ exec });
    const first = call(client, 'bash', { command: 'sleep 99' });
    await sleep(10);
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      timers.push(ms ?? 0);
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;
    let second: Promise<Res>;
    try {
      second = call(client, 'bash', { command: 'echo' });
      await sleep(10);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(timers).toContain(30_000);
    release();
    await first;
    expect((await second).isError).toBeFalsy(); // it got its turn well within the wait
  });

  it('runs calls that arrive within the wait one after another, in order', async () => {
    const order: string[] = [];
    const exec: Exec = async (command) => {
      order.push(`start ${command}`);
      await sleep(30);
      order.push(`end ${command}`);
      return res();
    };
    const { client } = await connect({ exec, busyWaitMs: 1_000 });
    const [a, b, c] = await Promise.all([
      call(client, 'bash', { command: 'a' }),
      call(client, 'bash', { command: 'b' }),
      call(client, 'read', { path: 'c' }),
    ]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(c.isError).toBeFalsy();
    expect(order).toEqual([
      'start a',
      'end a',
      'start b',
      'end b',
      expect.stringMatching(/^start cat/),
      expect.stringMatching(/^end cat/),
    ]);
  });

  it('keeps the line moving after a call fails', async () => {
    let n = 0;
    const exec: Exec = async () => {
      if (n++ === 0) throw new ExecMachineryError('sandbox failure: x');
      return res();
    };
    const { client } = await connect({ exec, busyWaitMs: 1_000 });
    const [a, b] = await Promise.all([
      call(client, 'bash', { command: 'a' }),
      call(client, 'bash', { command: 'b' }),
    ]);
    expect(a.isError).toBe(true);
    expect(text(b)).toBe('ok\n');
  });

  it('drops a cancelled queued call from the line without sending it', async () => {
    let release!: () => void;
    const sent: string[] = [];
    const exec: Exec = async (command) => {
      sent.push(command);
      if (command === 'slow') await new Promise<void>((r) => (release = r));
      return res();
    };
    const { client, records } = await connect({ exec, busyWaitMs: 5_000 });
    const first = call(client, 'bash', { command: 'slow' });
    await sleep(10);
    const ac = new AbortController();
    const second = call(client, 'bash', { command: 'queued' }, ac.signal);
    await sleep(10);
    ac.abort();
    await expect(second).rejects.toThrow();
    await sleep(10);
    expect(records).toMatchObject([
      { tool: 'bash', execs: 0, ok: false, error: 'cancelled by the client' },
    ]);
    release();
    await first;
    expect(sent).toEqual(['slow']);
    expect(text(await call(client, 'bash', { command: 'next' }))).toBe('ok\n');
  });

  it('passes a cancellation to the running Exec and records it', async () => {
    let seen: AbortSignal | undefined;
    const exec: Exec = (_c, o) =>
      new Promise((_r, reject) => {
        seen = o?.signal;
        o?.signal?.addEventListener('abort', () => reject(o.signal!.reason));
      });
    const { client, records } = await connect({ exec });
    const ac = new AbortController();
    const p = call(client, 'bash', { command: 'sleep 9' }, ac.signal);
    await sleep(10);
    ac.abort();
    await expect(p).rejects.toThrow();
    await sleep(10);
    expect(seen?.aborted).toBe(true);
    expect(records).toMatchObject([
      { tool: 'bash', execs: 1, ok: false, error: 'cancelled by the client' },
    ]);
    expect(text(await call(client, 'sandbox_info', {}))).toMatch(/^template default\n/);
  });
});

describe('lease mode (plan 4, spec §5)', () => {
  // The notice's HH:MM is local time: pin the zone so the copy is exact.
  let tz: string | undefined;
  beforeAll(() => {
    tz = process.env.TZ;
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  /** 2026-11-13 14:02:30 UTC. */
  const AT = Date.UTC(2026, 10, 13, 14, 2, 30);
  const ev = (over: Partial<LeaseEvent>): LeaseEvent =>
    LeaseEvent.fromPartial({ atUnixMs: AT, mode: SandboxMode.SANDBOX_MODE_LEASE, ...over });
  const END_IDLE =
    '[sandbox] guest restarted (idle, 14:02): /tmp, installs outside /workspace and background processes are gone';
  const PHRASE =
    'consecutive calls may share one guest until it restarts; no process survives a call; /tmp lasts until the guest restarts';
  const ACTIVE: LeaseStatusView = {
    mode: 'lease',
    epochKnown: true,
    state: 'active',
    ageMs: 42_900,
    idleTimeoutS: 900,
  };
  /** The end a reset of a live lease leaves pending (the worker keeps it until delivered). */
  const RESET_END = ev({ state: 'end', reason: 'reset', atUnixMs: AT + 5_000 });
  /**
   * A lease fake that answers `status` from `states` in turn (the last repeats) and records ops.
   * `reset` answers the view after it: RESET_END pending when the first state has a live lease.
   */
  const leaseFake = (...states: LeaseStatusView[]) => {
    const ops: string[] = [];
    let i = 0;
    const lease = async (op: 'status' | 'reset') => {
      ops.push(op);
      if (op === 'reset')
        return states[0]!.state === 'none'
          ? NO_LEASE
          : { ...NO_LEASE, mode: 'lease' as const, epochKnown: true, pending: RESET_END };
      return states[Math.min(i++, states.length - 1)]!;
    };
    return { ops, lease };
  };

  it('notice deduped on at_unix_ms; rides an error result', async () => {
    const end = ev({ state: 'end', reason: 'idle' });
    const answers: Array<ExecResult | Error> = [res({ lease: [end] }), res({ lease: [end] })];
    const ended = new ExecMachineryError(
      'sandbox failure: lease_ended(grace_limit)',
      9,
      'machinery',
      true,
    );
    ended.lease = [ev({ state: 'end', reason: 'grace_limit', atUnixMs: AT + 60_000 })];
    answers.push(ended);
    const exec: Exec = async () => {
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    };
    const { client } = await connect({ exec });
    expect(text(await call(client, 'bash', { command: 'a' }))).toBe(`${END_IDLE}\nok\n`);
    expect(text(await call(client, 'bash', { command: 'b' }))).toBe('ok\n');
    const failed = await call(client, 'bash', { command: 'c' });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toBe(
      '[sandbox] guest restarted (grace_limit, 14:03): /tmp, installs outside /workspace and background processes are gone\n' +
        "sandbox failure, not your command's output: lease_ended(grace_limit); the command may have partly run",
    );
  });

  it("collects edit's two Execs into one result; a start shows only without an end", async () => {
    const start = ev({ state: 'start', atUnixMs: AT + 1 });
    let n = 0;
    const exec: Exec = async () =>
      n++ === 0
        ? res({ stdout: Buffer.from('a b\n'), lease: [ev({ state: 'end', reason: 'idle' })] })
        : res({ lease: [start] });
    const { client } = await connect({ exec });
    const r = await call(client, 'edit', { path: 'f', edits: [{ oldText: 'a', newText: 'c' }] });
    expect(r.isError).toBeFalsy();
    expect(text(r).split('\n')[0]).toBe(END_IDLE);
    expect(text(r)).not.toContain('new guest');
    const later = ev({ state: 'start', atUnixMs: AT + 120_000 });
    const { client: c2 } = await connect({ exec: async () => res({ lease: [later] }) });
    expect(text(await call(c2, 'bash', { command: 'x' }))).toBe(
      '[sandbox] new guest (lease, 14:04)\nok\n',
    );
  });

  it('expiring line on every result while expiring', async () => {
    const now = AT;
    const expiring = ev({ state: 'expiring', endsByUnixMs: AT + 4 * 60_000 + 1 });
    const exec: Exec = async () => res({ stdout: Buffer.from('a b\n'), lease: [expiring] });
    const { client } = await connect({ exec, now: () => now });
    const line = '[sandbox] guest restarts within 5 min (max_duration)';
    expect(text(await call(client, 'bash', { command: 'a' }))).toBe(`${line}\na b\n`);
    expect(text(await call(client, 'bash', { command: 'b' }))).toBe(`${line}\na b\n`);
    // edit's two Execs both carry it: one line.
    const r = await call(client, 'edit', { path: 'f', edits: [{ oldText: 'a', newText: 'c' }] });
    expect(text(r).split(line)).toHaveLength(2);
  });

  it('reset tool ends the lease', async () => {
    const f = leaseFake(ACTIVE);
    const sent: string[] = [];
    const { client, records } = await connect({
      exec: async (c) => (sent.push(c), res()),
      lease: f.lease,
      mode: 'lease',
    });
    const r = await call(client, 'reset', {});
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('lease ended (reset): the next command starts a new guest');
    // No status first: the text comes from the reset's own answer (review #4569829039).
    expect(f.ops).toEqual(['reset']);
    expect(sent).toEqual([]);
    expect(records).toMatchObject([{ tool: 'reset', execs: 0, ok: true }]);
  });

  it('reset with no lease', async () => {
    const f = leaseFake(NO_LEASE);
    const { client } = await connect({ exec: async () => res(), lease: f.lease, mode: 'lease' });
    expect(text(await call(client, 'reset', {}))).toBe('no lease to reset');
    expect(f.ops).toEqual(['reset']);
  });

  it("reset's text comes from its own answer, and its end is not noticed again (review #4569829039)", async () => {
    // The lease ended between a status and the reset: the reset's answer has no reset end.
    const raced = async (op: 'status' | 'reset') => (op === 'status' ? ACTIVE : NO_LEASE);
    const { client: c1 } = await connect({ exec: async () => res(), lease: raced, mode: 'lease' });
    expect(text(await call(c1, 'reset', {}))).toBe('no lease to reset');
    // The reset's end rides the next Exec (the worker keeps it pending): said once, by reset.
    const f = leaseFake(ACTIVE);
    const { client } = await connect({
      exec: async () => res({ lease: [RESET_END] }),
      lease: f.lease,
      mode: 'lease',
    });
    expect(text(await call(client, 'reset', {}))).toBe(
      'lease ended (reset): the next command starts a new guest',
    );
    expect(text(await call(client, 'bash', { command: 'x' }))).toBe('ok\n');
    expect(text(await call(client, 'sandbox_info', {}))).toContain('\nlast end: reset, 14:02\n');
  });

  it('a reset whose reply lands as it is cancelled leaves its end for the next result (re-review New-1)', async () => {
    let first = true;
    const { client } = await connect({
      exec: async () => res({ lease: [RESET_END] }), // the worker keeps the end pending: it rides here
      mode: 'lease',
      lease: async (op, o) => {
        if (op !== 'reset' || !first) return NO_LEASE;
        first = false;
        // The worker's answer arrives just as the call is cancelled: the SDK discards it.
        return new Promise<LeaseStatusView>((resolve) =>
          o?.signal?.addEventListener('abort', () =>
            resolve({ ...NO_LEASE, mode: 'lease', epochKnown: true, pending: RESET_END }),
          ),
        );
      },
    });
    const ac = new AbortController();
    const p = call(client, 'reset', {}, ac.signal);
    await sleep(10);
    ac.abort();
    await expect(p).rejects.toThrow();
    await sleep(10);
    // Never said by the reset, so said by the next result, once.
    expect(text(await call(client, 'bash', { command: 'x' })).split('\n')[0]).toMatch(
      /^\[sandbox\] guest restarted \(reset, 14:02\)/,
    );
    expect(text(await call(client, 'bash', { command: 'y' }))).toBe('ok\n');
  });

  it('reset answers no lease for a pending reset end it has already seen (review #4569829039)', async () => {
    const f = leaseFake(ACTIVE);
    const { client } = await connect({
      exec: async () => res({ lease: [RESET_END] }),
      lease: f.lease,
      mode: 'lease',
    });
    // Another client's reset: its end already shown on this server's result.
    expect(text(await call(client, 'bash', { command: 'x' })).split('\n')[0]).toMatch(
      /^\[sandbox\] guest restarted \(reset, 14:02\)/,
    );
    expect(text(await call(client, 'reset', {}))).toBe('no lease to reset');
    // And a reset end older than an event already seen is not this reset's either.
    const later = ev({ state: 'start', atUnixMs: AT + 60_000 });
    const g = leaseFake(ACTIVE);
    const { client: c2 } = await connect({
      exec: async () => res({ lease: [later] }),
      lease: g.lease,
      mode: 'lease',
    });
    await call(c2, 'bash', { command: 'x' });
    expect(text(await call(c2, 'reset', {}))).toBe('no lease to reset');
  });

  it('a failed reset is a tool error naming the code', async () => {
    const { client } = await connect({
      exec: async () => res(),
      mode: 'lease',
      lease: async (op) => {
        if (op === 'status') return ACTIVE;
        throw new LeaseControlError('timeout', 'deadline exceeded');
      },
    });
    const r = await call(client, 'reset', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('the lease call failed (timeout): deadline exceeded');
  });

  it('a cancelled reset stops waiting on its lease call and frees the call queue (M1)', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { client, records } = await connect({
      exec: async () => res(),
      mode: 'lease',
      busyWaitMs: 200,
      lease: async (op, o) => {
        signals.push(o?.signal);
        if (op === 'status') return ACTIVE;
        // The worker holds a reset behind another client's Exec, up to grace_limit (30 min).
        return new Promise<LeaseStatusView>((_, reject) =>
          o?.signal?.addEventListener('abort', () =>
            reject(new LeaseControlError('cancelled', 'the lease call was cancelled')),
          ),
        );
      },
    });
    const ac = new AbortController();
    const p = call(client, 'reset', {}, ac.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(signals.every((x) => x instanceof AbortSignal && x.aborted)).toBe(true);
    // The queue is free: the next call runs at once instead of being refused as busy.
    expect(text(await call(client, 'bash', { command: 'echo ok' }))).toBe('ok\n');
    expect(records).toMatchObject([
      { tool: 'reset', execs: 0, ok: false, error: 'cancelled by the client' },
      { tool: 'bash', ok: true },
    ]);
  });

  it('sandbox_info shows the lease fields', async () => {
    const f = leaseFake(ACTIVE);
    const exec: Exec = async () => res({ lease: [ev({ state: 'end', reason: 'idle' })] });
    const { client } = await connect({ exec, lease: f.lease, mode: 'lease' });
    expect(text(await call(client, 'sandbox_info', {}))).toBe(
      [
        'template default',
        'mode: lease',
        'lease: active',
        'age: 42s',
        'idle timeout: 900s',
        'last end: none',
        'tracked processes: none',
      ].join('\n'),
    );
    await call(client, 'bash', { command: 'x' });
    expect(text(await call(client, 'sandbox_info', {}))).toContain('\nlast end: idle, 14:02\n');
    expect(f.ops).toEqual(['status', 'status']);
    const zero = leaseFake({ ...ACTIVE, idleTimeoutS: 0 });
    const { client: c2 } = await connect({ exec, lease: zero.lease, mode: 'lease' });
    expect(text(await call(c2, 'sandbox_info', {}))).toContain(
      '\nidle timeout: 0s (the worker default)\n',
    );
  });

  it('sandbox_info on a per-exec sandbox makes no lease call (P4-R9)', async () => {
    const f = leaseFake(ACTIVE);
    const { client } = await connect({ exec: async () => res(), lease: f.lease });
    expect(text(await call(client, 'sandbox_info', {}))).toBe(
      [
        'template default',
        'mode: per-exec',
        'lease: none (per-exec)',
        'last end: none',
        'tracked processes: none',
      ].join('\n'),
    );
    expect(f.ops).toEqual([]);
  });

  it("sandbox_info follows the re-fetched record's mode, the status-failure fallback included", async () => {
    // Started lease, now per-exec: no status call.
    const down = leaseFake(ACTIVE);
    const { client } = await connect({
      exec: async () => res(),
      mode: 'lease',
      lease: down.lease,
      info: async () => ({ text: 'template default', mode: 'per-exec' }),
    });
    expect(text(await call(client, 'sandbox_info', {}))).toContain(
      '\nmode: per-exec\nlease: none (per-exec)\n',
    );
    expect(down.ops).toEqual([]);
    // Started per-exec, now lease+processes: status is asked, and its failure names the new mode.
    const ops: string[] = [];
    const { client: up } = await connect({
      exec: async () => res(),
      info: async () => ({ text: 'template default', mode: 'lease+processes' }),
      lease: async (op) => {
        ops.push(op);
        throw new LeaseControlError('timeout', 'slow');
      },
    });
    expect(text(await call(up, 'sandbox_info', {}))).toBe(
      [
        'template default',
        'mode: lease+processes',
        'lease: unknown (timeout)',
        'last end: none',
        // A failed status cannot say which processes run (plan 5).
        'tracked processes: unknown',
      ].join('\n'),
    );
    expect(ops).toEqual(['status']);
  });

  it("the latest minted token's mode decides over the record's", async () => {
    const f = leaseFake(ACTIVE);
    let minted: 'per-exec' | 'lease' | undefined;
    const { client } = await connect({
      exec: async () => res(),
      lease: f.lease,
      leaseMode: () => minted,
    });
    // No token yet: the start record (per-exec) decides.
    expect(text(await call(client, 'reset', {}))).toBe('no lease to reset');
    expect(f.ops).toEqual([]);
    minted = 'lease';
    expect(text(await call(client, 'reset', {}))).toBe(
      'lease ended (reset): the next command starts a new guest',
    );
    expect(f.ops).toEqual(['reset']);
    expect(text(await call(client, 'sandbox_info', {}))).toContain(
      '\nmode: lease\nlease: active\n',
    );
    // And back: a per-exec token beats a lease record.
    minted = 'per-exec';
    const g = leaseFake(ACTIVE);
    const { client: c2 } = await connect({
      exec: async () => res(),
      lease: g.lease,
      mode: 'lease',
      info: async () => ({ text: 'template default', mode: 'lease' }),
      leaseMode: () => minted,
    });
    expect(text(await call(c2, 'sandbox_info', {}))).toContain(
      '\nmode: per-exec\nlease: none (per-exec)\n',
    );
    expect(text(await call(c2, 'reset', {}))).toBe('no lease to reset');
    expect(g.ops).toEqual([]);
  });

  it('reset before any mint re-reads the record: upgraded since start, it resets', async () => {
    const f = leaseFake(ACTIVE);
    let infos = 0;
    const { client } = await connect({
      exec: async () => res(),
      lease: f.lease,
      info: async () => (infos++, { text: 'template default', mode: 'lease' }),
      leaseMode: () => undefined,
    });
    expect(text(await call(client, 'reset', {}))).toBe(
      'lease ended (reset): the next command starts a new guest',
    );
    expect(f.ops).toEqual(['reset']);
    expect(infos).toBe(1);
  });

  it("sandbox_info's last end includes a cancelled call's held end", async () => {
    const end = ev({ state: 'end', reason: 'idle' });
    const exec: Exec = (_c, o) =>
      new Promise((_r, reject) => {
        o?.signal?.addEventListener('abort', () => {
          const e = new ExecAbortedError(o.signal!);
          e.lease = [end];
          reject(e);
        });
      });
    const { client } = await connect({ exec });
    const ac = new AbortController();
    const p = call(client, 'bash', { command: 'sleep 9' }, ac.signal);
    await sleep(10);
    ac.abort();
    await expect(p).rejects.toThrow();
    await sleep(10);
    const info = text(await call(client, 'sandbox_info', {}));
    expect(info.split('\n')[0]).toBe(END_IDLE);
    expect(info).toContain('\nlast end: idle, 14:02\n');
  });

  it('reset on a per-exec sandbox makes no lease call', async () => {
    const f = leaseFake(ACTIVE);
    const { client } = await connect({ exec: async () => res(), lease: f.lease });
    expect(text(await call(client, 'reset', {}))).toBe('no lease to reset');
    expect(f.ops).toEqual([]);
  });

  it("a cancelled call's lease events ride the next result", async () => {
    const end = ev({ state: 'end', reason: 'idle' });
    let first = true;
    const exec: Exec = (_c, o) =>
      first
        ? ((first = false),
          new Promise((_r, reject) => {
            o?.signal?.addEventListener('abort', () => {
              const e = new ExecAbortedError(o.signal!);
              e.lease = [end];
              reject(e);
            });
          }))
        : Promise.resolve(res()); // the worker sent it once, on the cancelled Exec
    const { client } = await connect({ exec });
    const ac = new AbortController();
    const p = call(client, 'bash', { command: 'sleep 9' }, ac.signal);
    await sleep(10);
    ac.abort();
    await expect(p).rejects.toThrow();
    await sleep(10);
    expect(text(await call(client, 'bash', { command: 'next' }))).toBe(`${END_IDLE}\nok\n`);
    expect(text(await call(client, 'bash', { command: 'again' }))).toBe('ok\n');
  });

  /** A real SandboxExecConn against a fake relay answering each Exec from `answers`, in turn. */
  const overRelay = async (...answers: FakeExecAnswer[]) => {
    const relay = await fakeExecRelay(() => answers.shift() ?? {});
    closers.push(async () => relay.close());
    const conn = new SandboxExecConn({
      addr: relay.addr,
      tls: false,
      sandboxId: 'sbx_default',
      workspaceKey: 'sbx-aaaa',
      token: async () => ({
        token: 't',
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        lifetimeS: 900,
      }),
    });
    closers.push(async () => conn.close());
    return { relay, exec: conn.exec };
  };

  it("a cancelled call's lease events ride the next result, over the real client (review #4569829023)", async () => {
    const end = ev({ state: 'end', reason: 'idle' });
    // The worker sends the end on the Exec that is then cancelled, and acks it: never again.
    const { relay, exec } = await overRelay(
      { lease: [end], stdout: 'started', hang: true },
      { stdout: 'ok\n' },
      { stdout: 'ok\n' },
    );
    const { client } = await connect({ exec });
    const ac = new AbortController();
    const p = call(client, 'bash', { command: 'sleep 600' }, ac.signal);
    await vi.waitFor(() => expect(relay.seen).toHaveLength(1));
    await sleep(50); // the lease event and the chunk reach the client
    ac.abort();
    await expect(p).rejects.toThrow();
    await sleep(10);
    expect(text(await call(client, 'bash', { command: 'next' }))).toBe(`${END_IDLE}\nok\n`);
    expect(text(await call(client, 'bash', { command: 'again' }))).toBe('ok\n');
  });

  it("a refused Exec's lease events ride its error result (review #4569829028)", async () => {
    const end = ev({ state: 'end', reason: 'idle' });
    const refused = new ExecRefusedError(
      'token rejected (after a stale_mode refusal and a fresh token)',
      16,
      [end],
    );
    const { client } = await connect({ exec: throwing(refused) });
    const r = await call(client, 'bash', { command: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r).split('\n')[0]).toBe(END_IDLE);
  });

  it('a call whose run resolves after its cancel holds its events for the next result (review #4569829034)', async () => {
    const end = ev({ state: 'end', reason: 'idle' });
    let first = true;
    // The Exec's answer lands just as the cancel arrives: the SDK discards the result.
    const exec: Exec = (_c, o) =>
      first
        ? ((first = false),
          new Promise((resolve) =>
            o?.signal?.addEventListener('abort', () => resolve(res({ lease: [end] }))),
          ))
        : Promise.resolve(res());
    const { client } = await connect({ exec });
    const ac = new AbortController();
    const p = call(client, 'bash', { command: 'sleep 9' }, ac.signal);
    await sleep(10);
    ac.abort();
    await expect(p).rejects.toThrow();
    await sleep(10);
    expect(text(await call(client, 'bash', { command: 'next' }))).toBe(`${END_IDLE}\nok\n`);
    expect(text(await call(client, 'bash', { command: 'again' }))).toBe('ok\n');
  });

  it('keeps only the last expiring event of a result', async () => {
    let n = 0;
    // edit's two Execs straddle a minute boundary: 5 min, then 4 min left.
    const exec: Exec = async () =>
      n++ === 0
        ? res({
            stdout: Buffer.from('a b\n'),
            lease: [ev({ state: 'expiring', endsByUnixMs: AT + 4 * 60_000 + 1 })],
          })
        : res({ lease: [ev({ state: 'expiring', endsByUnixMs: AT + 4 * 60_000 - 1 })] });
    const { client } = await connect({ exec, now: () => AT });
    const r = await call(client, 'edit', { path: 'f', edits: [{ oldText: 'a', newText: 'c' }] });
    const lines = text(r).split('\n');
    expect(lines[0]).toBe('[sandbox] guest restarts within 4 min (max_duration)');
    expect(text(r)).not.toContain('within 5 min');
  });

  it('sandbox_info survives a status failure', async () => {
    const { client, records } = await connect({
      exec: async () => res(),
      mode: 'lease',
      lease: async () => {
        throw new LeaseControlError('unavailable', 'no route');
      },
    });
    const r = await call(client, 'sandbox_info', {});
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe(
      [
        'template default',
        'mode: lease',
        'lease: unknown (unavailable)',
        'last end: none',
        'tracked processes: unknown',
      ].join('\n'),
    );
    expect(records).toMatchObject([{ tool: 'sandbox_info', ok: true }]);
  });

  it('lease-mode tool descriptions and rules', async () => {
    const { client } = await connect({ exec: async () => res(), mode: 'lease' });
    expect(client.getInstructions()).toBe(sandboxRules('/workspace', 'lease'));
    expect(client.getInstructions()).toContain(PHRASE);
    expect(client.getInstructions()).not.toMatch(/fresh VM/);
    expect(client.getInstructions()).not.toMatch(/nothing else does/);
    const { tools } = await client.listTools();
    for (const name of ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls']) {
      const d = tools.find((t) => t.name === name)!.description!;
      expect(d, name).toContain(PHRASE);
      expect(d, name).not.toMatch(/fresh VM/);
    }
    expect(tools.find((t) => t.name === 'reset')!.description).toMatch(/new guest/);
    // Per-exec keeps today's wording.
    const { client: pe } = await connect({ exec: async () => res(), mode: 'per-exec' });
    expect(pe.getInstructions()).toBe(MCP_INSTRUCTIONS);
    const peTools = (await pe.listTools()).tools;
    expect(peTools.find((t) => t.name === 'bash')!.description).toMatch(/Every call is a fresh VM/);
    expect(peTools.find((t) => t.name === 'bash')!.description).not.toContain(PHRASE);
    // Level 2 has its own lease rule, which never says that no process survives (fix round 1).
    expect(sandboxRules('/workspace', 'lease+processes')).not.toContain(PHRASE);
    expect(sandboxRules('/workspace', 'lease+processes')).not.toBe(
      sandboxRules('/workspace', 'lease'),
    );
  });
});

describe('execFailureText: one mapping for the MCP server and mocactl', () => {
  it('drops the model-facing "not your command\'s output" for the CLI, and nothing else', () => {
    const boot = new ExecMachineryError('sandbox failure: vm boot failed', 13);
    expect(execFailureText(boot)).toBe(
      "sandbox failure, not your command's output: vm boot failed",
    );
    expect(execFailureText(boot, { audience: 'cli' })).toBe('sandbox failure: vm boot failed');
    const busy = new ExecMachineryError('sandbox busy: 4 in flight', 8, 'busy');
    expect(execFailureText(busy, { audience: 'cli' })).toBe(execFailureText(busy));
    const refused = new ExecRefusedError('workspace not owned by this sandbox', 7);
    expect(execFailureText(refused, { audience: 'cli' })).toBe(execFailureText(refused));
  });

  it('says a machinery failure after the command started may have partly run, to both audiences (final review M2)', () => {
    const cut = new ExecMachineryError(
      'sandbox failure: UNAVAILABLE: Connection dropped',
      14,
      'machinery',
      true,
    );
    expect(execFailureText(cut)).toBe(
      "sandbox failure, not your command's output: UNAVAILABLE: Connection dropped; " +
        'the command may have partly run',
    );
    expect(execFailureText(cut, { audience: 'cli' })).toBe(
      'sandbox failure: UNAVAILABLE: Connection dropped; the command may have partly run',
    );
    expect(TOKEN_EXPIRED_TEXT).toContain('the command may have partly run');
    // Before it started: no such clause.
    const early = new ExecMachineryError('sandbox failure: vm boot failed', 13);
    expect(execFailureText(early)).not.toContain('may have partly run');
  });

  it('is undefined for an error that is not an Exec failure', () => {
    expect(execFailureText(new Error('x'))).toBeUndefined();
  });

  it('says the sandbox is ending as it is, to the model and the CLI alike (final review M1)', () => {
    const ending = new ExecMachineryError(
      'the sandbox expires in 30 s; pull your work now: `mocactl sbx pull --apply`',
      undefined,
      'expiring',
    );
    expect(execFailureText(ending)).toBe(ending.message);
    expect(execFailureText(ending, { audience: 'cli' })).toBe(ending.message);
  });
});

describe('level 2: tracked processes (plan 5, spec §7)', () => {
  let tz: string | undefined;
  beforeAll(() => {
    tz = process.env.TZ;
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });
  const AT = Date.UTC(2026, 10, 13, 14, 2, 30);
  const ev = (over: Partial<LeaseEvent>): LeaseEvent =>
    LeaseEvent.fromPartial({
      atUnixMs: AT,
      mode: SandboxMode.SANDBOX_MODE_LEASE_PROCESSES,
      ...over,
    });
  const END_IDLE =
    '[sandbox] guest restarted (idle, 14:02): /tmp, installs outside /workspace and background processes are gone';
  const NINE = ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls', 'sandbox_info', 'reset'];
  const FOUR = ['process_start', 'process_list', 'process_logs', 'process_stop'];
  const REFUSAL =
    'processes not enabled for this sandbox; ask the user to run: mocactl sbx mode sbx_0123abcd lease+processes';
  const L2_SENTENCE =
    '`&`, `nohup` and `setsid` do not survive the call, and `process_start` does, when the sandbox allows it.';
  const view = (over: Record<string, unknown> = {}) => ({
    id: '3',
    name: 'web',
    pid: 412,
    state: 'running',
    code: 0,
    ageMs: 130_000,
    memoryBytes: 12 * 1024 * 1024,
    ...over,
  });
  /** A process call that records each op and answers `answer`'s result with its `lease` events. */
  function procs(
    answer: (op: string) => unknown = () => [],
    lease: (op: string) => LeaseEvent[] = () => [],
  ) {
    const ops: string[] = [];
    const process = (async (op: string) => {
      ops.push(op);
      const a = answer(op);
      if (a instanceof Error) throw a;
      return { result: a, lease: lease(op) };
    }) as unknown as ProcessCall;
    return { process, ops };
  }
  const neverExec: Exec = async () => {
    throw new Error('no command Exec expected');
  };
  const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

  it("lists the process tools only while the current token's mode is lease+processes (P5-R27)", async () => {
    let minted: 'per-exec' | 'lease' | 'lease+processes' | undefined;
    const { client } = await connect({
      exec: neverExec,
      mode: 'lease+processes',
      leaseMode: () => minted,
      sandboxId: 'sbx_0123abcd',
    });
    // No token yet: the record read at start decides.
    expect(await names(client)).toEqual([...NINE, ...FOUR]);
    minted = 'lease';
    expect(await names(client)).toEqual(NINE);
    minted = 'lease+processes';
    expect(await names(client)).toEqual([...NINE, ...FOUR]);
    minted = 'per-exec';
    expect(await names(client)).toEqual(NINE);
    const { client: lease } = await connect({ exec: neverExec, mode: 'lease' });
    expect(await names(lease)).toEqual(NINE);
  });

  it('a process call at a lower mode answers the exact §7 refusal and sends nothing', async () => {
    let minted: 'per-exec' | 'lease' | 'lease+processes' | undefined = 'lease';
    const p = procs();
    const execs: string[] = [];
    const { client, records } = await connect({
      exec: async (c) => (execs.push(c), res()),
      process: p.process,
      mode: 'lease+processes',
      leaseMode: () => minted,
      sandboxId: 'sbx_0123abcd',
    });
    for (const [name, args] of [
      ['process_start', { command: 'sleep 9' }],
      ['process_list', {}],
      ['process_logs', { name: 'web' }],
      ['process_stop', { id: '3' }],
    ] as const) {
      const r = await call(client, name, args);
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toBe(REFUSAL);
    }
    expect(p.ops).toEqual([]);
    expect(execs).toEqual([]);
    expect(records.map((r) => [r.tool, r.execs, r.ok])).toEqual([
      ['process_start', 0, false],
      ['process_list', 0, false],
      ['process_logs', 0, false],
      ['process_stop', 0, false],
    ]);
    // A per-exec record and no token: refused too.
    minted = undefined;
    const { client: pe } = await connect({
      exec: neverExec,
      process: p.process,
      sandboxId: 'sbx_0123abcd',
    });
    expect(text(await call(pe, 'process_list', {}))).toBe(REFUSAL);
    expect(p.ops).toEqual([]);
  });

  it("maps the relay's or worker's processes_not_enabled to the same §7 text", async () => {
    const p = procs(
      () => new ProcessError('processes_not_enabled', "this sandbox's mode is lease", 'x'),
    );
    const { client } = await connect({
      exec: neverExec,
      process: p.process,
      mode: 'lease+processes',
      sandboxId: 'sbx_0123abcd',
    });
    const r = await call(client, 'process_list', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(REFUSAL);
    expect(p.ops).toEqual(['list']);
  });

  it('maps the other process wire errors to clear tool errors', async () => {
    const cases: [ProcessError, string][] = [
      [
        new ProcessError('process_not_found', 'web', ''),
        'no tracked process web; process_list shows them',
      ],
      [
        // The guest's bare id, shown as the rows show ids (final review M2).
        new ProcessError('process_not_found', '3', 'process_not_found: 3'),
        'no tracked process p3; process_list shows them',
      ],
      [
        new ProcessError('process_limit', '4 running (SH_LEASE_MAX_PROCESSES)', ''),
        'too many tracked processes: 4 running (SH_LEASE_MAX_PROCESSES); stop one with process_stop first',
      ],
      [
        new ProcessError('process_name_taken', 'web', ''),
        'a running process is already named web; choose another name, or stop it first',
      ],
      [
        new ProcessError('process_cwd', '../x: outside the workspace', ''),
        'invalid cwd: ../x: outside the workspace',
      ],
      [
        new ProcessError('process_name_invalid', '"a b": want 1-64 characters', ''),
        'invalid name: "a b": want 1-64 characters',
      ],
      [
        new ProcessError('process_signal', 'unknown signal FOO', ''),
        'invalid signal: unknown signal FOO',
      ],
      [
        new ProcessError('lease_unsupported', 'the snapshot has no lease-processes-v1', ''),
        "this sandbox's guest cannot run tracked processes: the snapshot has no lease-processes-v1",
      ],
      [
        // The relay's worker gate (P5-R37): the worker predates level 2.
        new ProcessError(
          'lease_unsupported',
          "this sandbox's worker does not support tracked processes",
          "lease_unsupported: this sandbox's worker does not support tracked processes",
        ),
        "tracked processes are not available on this sandbox's worker yet (ask the user to tell the operator)",
      ],
    ];
    for (const [e, want] of cases) {
      const { client } = await connect({
        exec: neverExec,
        process: procs(() => e).process,
        mode: 'lease+processes',
      });
      const r = await call(client, 'process_logs', { name: 'web' });
      expect(r.isError, e.code).toBe(true);
      expect(text(r), e.code).toBe(want);
    }
  });

  it('runs the process tools at lease+processes, one Exec each, through the call queue', async () => {
    const p = procs((op) =>
      op === 'start'
        ? { id: '3', name: 'web', pid: 412 }
        : op === 'list'
          ? [view()]
          : op === 'logs'
            ? 'serving\n'
            : view({ state: 'exited', code: 0 }),
    );
    const { client, records } = await connect({
      exec: neverExec,
      process: p.process,
      mode: 'lease+processes',
    });
    expect(text(await call(client, 'process_start', { command: 'serve', name: 'web' }))).toBe(
      'started p3 web (pid 412)',
    );
    expect(text(await call(client, 'process_list', {}))).toBe(
      'p3 web (pid 412): running, 2m10s, 12.0 MiB',
    );
    expect(text(await call(client, 'process_logs', { name: 'web' }))).toBe('serving\n');
    expect(text(await call(client, 'process_stop', { name: 'web' }))).toBe(
      'final state: p3 web (pid 412): exited(0), 12.0 MiB',
    );
    expect(p.ops).toEqual(['start', 'list', 'logs', 'stop']);
    expect(records.map((r) => [r.tool, r.execs, r.ok])).toEqual([
      ['process_start', 1, true],
      ['process_list', 1, true],
      ['process_logs', 1, true],
      ['process_stop', 1, true],
    ]);
  });

  it("puts a process call's lease events first in its result, and a failed one's too", async () => {
    const end = ev({ state: 'end', reason: 'idle' });
    const failing = new ProcessError('process_not_found', 'web', 'process_not_found: web', [end]);
    let fail = false;
    const p = procs(
      () => (fail ? failing : []),
      () => [end],
    );
    const { client } = await connect({
      exec: neverExec,
      process: p.process,
      mode: 'lease+processes',
    });
    expect(text(await call(client, 'process_list', {}))).toBe(`${END_IDLE}\nno tracked processes`);
    fail = true;
    const later = ev({ state: 'end', reason: 'reset', atUnixMs: AT + 60_000 });
    failing.lease = [later];
    const r = await call(client, 'process_logs', { name: 'web' });
    expect(r.isError).toBe(true);
    expect(text(r).split('\n')[0]).toMatch(/^\[sandbox\] guest restarted \(reset, 14:03\)/);
  });

  it('M3: a process call that resolves after its cancel keeps its notice for the next result', async () => {
    const end = ev({ state: 'end', reason: 'idle' });
    let first = true;
    const process = ((_op: string, _args: unknown, o?: { signal?: AbortSignal }) =>
      first
        ? ((first = false),
          new Promise((resolve) =>
            o?.signal?.addEventListener('abort', () => resolve({ result: [], lease: [end] })),
          ))
        : Promise.resolve({ result: [], lease: [] })) as unknown as ProcessCall;
    const { client } = await connect({ exec: neverExec, process, mode: 'lease+processes' });
    const ac = new AbortController();
    const pending = call(client, 'process_list', {}, ac.signal);
    await sleep(10);
    ac.abort();
    await expect(pending).rejects.toThrow();
    await sleep(10);
    expect(text(await call(client, 'process_list', {}))).toBe(`${END_IDLE}\nno tracked processes`);
    expect(text(await call(client, 'process_list', {}))).toBe('no tracked processes');
  });

  it('M3: a cancelled process call whose rejection carries events holds them for the next result', async () => {
    const end = ev({ state: 'end', reason: 'idle' });
    let first = true;
    const process = ((_op: string, _args: unknown, o?: { signal?: AbortSignal }) =>
      first
        ? ((first = false),
          new Promise((_r, reject) =>
            o?.signal?.addEventListener('abort', () => {
              const e = new ExecAbortedError(o.signal!);
              e.lease = [end];
              reject(e);
            }),
          ))
        : Promise.resolve({ result: [], lease: [] })) as unknown as ProcessCall;
    const { client } = await connect({ exec: neverExec, process, mode: 'lease+processes' });
    const ac = new AbortController();
    const pending = call(client, 'process_list', {}, ac.signal);
    await sleep(10);
    ac.abort();
    await expect(pending).rejects.toThrow();
    await sleep(10);
    expect(text(await call(client, 'process_list', {}))).toBe(`${END_IDLE}\nno tracked processes`);
  });

  it('shows the processes_stopped notice on the next result', async () => {
    const stopped = ev({
      state: 'processes_stopped',
      reason: 'mode_change',
      processes: ['web (pid 412)'],
    });
    const { client } = await connect({
      exec: async () => res({ lease: [stopped] }),
      mode: 'lease',
    });
    expect(text(await call(client, 'bash', { command: 'x' }))).toBe(
      '[sandbox] tracked processes stopped (mode_change, 14:02): web (pid 412)\nok\n',
    );
  });

  it('declares tools.listChanged, and sends list_changed when a mint differs from the listed mode (P5-R27)', async () => {
    let minted: 'lease' | 'lease+processes' | undefined;
    const { client, server } = await connect({
      exec: neverExec,
      mode: 'lease',
      leaseMode: () => minted,
    });
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed++;
    });
    const mint = async (m: 'lease' | 'lease+processes') => {
      minted = m;
      server.tokenMinted(m);
      await sleep(10);
    };
    // Nothing listed yet: the first list will be right, so no notice.
    await mint('lease+processes');
    expect(changed).toBe(0);
    await client.listTools(); // listed under lease+processes
    await mint('lease+processes'); // the listed mode
    expect(changed).toBe(0);
    await mint('lease'); // a downgrade
    expect(changed).toBe(1);
    await client.listTools(); // the client re-lists: lease
    await mint('lease+processes'); // and back
    expect(changed).toBe(2);
  });

  it('sends one list_changed for two mints at the same new mode, and none for a mint back to the listed one (Minor 4)', async () => {
    const { client, server } = await connect({ exec: neverExec, mode: 'lease' });
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed++;
    });
    await client.listTools(); // listed under lease
    server.tokenMinted('lease+processes');
    server.tokenMinted('lease+processes');
    await sleep(10);
    expect(changed).toBe(1);
    // Not re-listed yet: a mint back to the listed mode needs no second notice.
    server.tokenMinted('lease');
    await sleep(10);
    expect(changed).toBe(1);
  });

  it('sends list_changed on the first mint only when the tools were listed under another mode', async () => {
    for (const [listed, minted, want] of [
      ['lease', 'lease+processes', 1],
      ['lease', 'lease', 0],
      ['lease+processes', 'lease', 1],
    ] as const) {
      const { client, server } = await connect({ exec: neverExec, mode: listed });
      let changed = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        changed++;
      });
      await client.listTools();
      server.tokenMinted(minted);
      await sleep(10);
      expect(changed, `${listed} -> ${minted}`).toBe(want);
    }
  });

  it('level-2 texts: the bash description and the rules carry the §7 sentence at lease+processes only', async () => {
    let minted: 'lease' | 'lease+processes' | undefined;
    const { client } = await connect({ exec: neverExec, mode: 'lease', leaseMode: () => minted });
    const bash = async () => (await client.listTools()).tools.find((t) => t.name === 'bash')!;
    expect((await bash()).description).not.toContain(L2_SENTENCE);
    expect((await bash()).description).toMatch(/Never start background jobs/);
    // The descriptions are rebuilt for the mode the token now says.
    minted = 'lease+processes';
    const d = (await bash()).description!;
    expect(d).toContain(L2_SENTENCE);
    expect(d).not.toMatch(/Never start background jobs/);
    expect(sandboxRules('/workspace', 'lease+processes')).toContain(L2_SENTENCE);
    expect(sandboxRules('/workspace', 'lease')).not.toContain(L2_SENTENCE);
    expect(sandboxRules('/workspace', 'per-exec')).not.toContain(L2_SENTENCE);
    const { client: l2 } = await connect({ exec: neverExec, mode: 'lease+processes' });
    expect(l2.getInstructions()).toBe(sandboxRules('/workspace', 'lease+processes'));
    expect(l2.getInstructions()).not.toMatch(/Never start background jobs/);
  });

  it('level-2 texts never say that no process survives a call (fix round 1, Minor 2)', async () => {
    const L2_RULE =
      'consecutive calls may share one guest until it restarts; a process started with `&`, `nohup` or `setsid` does not survive the call; /tmp lasts until the guest restarts';
    expect(LEASE_PROCESSES_RULE).toBe(L2_RULE);
    const { client } = await connect({ exec: neverExec, mode: 'lease+processes' });
    expect(client.getInstructions()).toContain(L2_RULE);
    expect(client.getInstructions()).toContain(L2_SENTENCE);
    expect(client.getInstructions()).not.toContain('no process survives');
    for (const t of (await client.listTools()).tools) {
      expect(t.description, t.name).not.toContain('no process survives');
    }
    const bash = (await client.listTools()).tools.find((t) => t.name === 'bash')!.description!;
    expect(bash).toContain(L2_RULE);
    expect(bash).toContain(L2_SENTENCE);
    // Level 1 keeps its wording.
    const { client: l1 } = await connect({ exec: neverExec, mode: 'lease' });
    const l1bash = (await l1.listTools()).tools.find((t) => t.name === 'bash')!.description!;
    expect(l1bash).toContain(LEASE_RULE);
    expect(l1.getInstructions()).toContain(LEASE_RULE);
  });

  it('sandbox_info lists the tracked processes from the lease status, exited ones included', async () => {
    const { client } = await connect({
      exec: neverExec,
      mode: 'lease+processes',
      info: async () => ({ text: 'template default', mode: 'lease+processes' }),
      lease: async () => ({
        mode: 'lease+processes',
        epochKnown: true,
        state: 'active',
        ageMs: 61_000,
        idleTimeoutS: 900,
        processes: [
          view(),
          view({
            id: '4',
            name: 'p4',
            pid: 9,
            state: 'killed',
            code: 9,
            ageMs: 5_000,
            memoryBytes: 0,
          }),
        ],
      }),
    });
    expect(text(await call(client, 'sandbox_info', {}))).toBe(
      [
        'template default',
        'mode: lease+processes',
        'lease: active',
        'age: 61s',
        'idle timeout: 900s',
        'last end: none',
        // The worker's mirror, refreshed by each call (P5-R38): a status touches no guest.
        'tracked processes (as of the last call):',
        '  p3 web (pid 412): running, 2m10s, 12.0 MiB',
        '  p4 (pid 9): killed(9), 0.0 MiB',
      ].join('\n'),
    );
  });
});

describe('the §7 refusal clears once the user upgrades (fix round 1, P5-R29)', () => {
  const REFUSAL =
    'processes not enabled for this sandbox; ask the user to run: mocactl sbx mode sbx_0123abcd lease+processes';
  const neverExec: Exec = async () => {
    throw new Error('no command Exec expected');
  };
  function procs() {
    const ops: string[] = [];
    const processCall = (async (op: string) => {
      ops.push(op);
      return { result: op === 'start' ? { id: '1', name: 'web', pid: 7 } : [], lease: [] };
    }) as unknown as ProcessCall;
    return { processCall, ops };
  }

  it('a held token below lease+processes is re-minted once; an upgraded record lets the call through', async () => {
    let minted: 'lease' | 'lease+processes' = 'lease';
    const refreshes: (AbortSignal | undefined)[] = [];
    const p = procs();
    const { client } = await connect({
      exec: neverExec,
      process: p.processCall,
      mode: 'lease',
      sandboxId: 'sbx_0123abcd',
      leaseMode: () => minted,
      // The fresh mint reads the record as it is now: the user upgraded.
      refreshMode: async (signal) => {
        refreshes.push(signal);
        minted = 'lease+processes';
        return minted;
      },
    });
    const r = await call(client, 'process_start', { command: 'serve', name: 'web' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('started p1 web (pid 7)');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toBeInstanceOf(AbortSignal);
    expect(p.ops).toEqual(['start']);
    // Now at level 2: no more re-mints.
    await call(client, 'process_list', {});
    expect(refreshes).toHaveLength(1);
  });

  it('a record still below lease+processes is refused after exactly one re-mint, with no Exec', async () => {
    let refreshes = 0;
    const p = procs();
    const execs: string[] = [];
    const { client, records } = await connect({
      exec: async (c) => (execs.push(c), res()),
      process: p.processCall,
      mode: 'lease',
      sandboxId: 'sbx_0123abcd',
      leaseMode: () => 'lease',
      refreshMode: async () => (refreshes++, 'lease'),
    });
    const r = await call(client, 'process_start', { command: 'serve' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(REFUSAL);
    expect(refreshes).toBe(1);
    expect(p.ops).toEqual([]);
    expect(execs).toEqual([]);
    expect(records).toMatchObject([{ tool: 'process_start', execs: 0, ok: false }]);
  });

  it('a re-mint that fails is the tool error, and nothing is sent', async () => {
    const p = procs();
    const { client } = await connect({
      exec: neverExec,
      process: p.processCall,
      mode: 'lease',
      leaseMode: () => 'lease',
      refreshMode: async () => {
        throw new Error('control plane unreachable');
      },
    });
    const r = await call(client, 'process_list', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('sandbox unavailable: control plane unreachable');
    expect(p.ops).toEqual([]);
  });

  it('never re-mints for a non-process tool, nor once the token is at lease+processes', async () => {
    let refreshes = 0;
    const p = procs();
    let minted: 'lease' | 'lease+processes' = 'lease';
    const { client } = await connect({
      exec: async () => res(),
      process: p.processCall,
      mode: 'lease',
      leaseMode: () => minted,
      refreshMode: async () => (refreshes++, minted),
    });
    await call(client, 'bash', { command: 'x' });
    expect(refreshes).toBe(0);
    minted = 'lease+processes';
    await call(client, 'process_list', {});
    expect(refreshes).toBe(0);
    expect(p.ops).toEqual(['list']);
  });
});

describe('execFailureText for a process refusal', () => {
  it('names the command without "ask the user" for the CLI (Minor 3)', () => {
    const e = new ProcessError('processes_not_enabled', "this sandbox's mode is lease", '');
    expect(execFailureText(e, { audience: 'cli', sandboxId: 'sbx_0123abcd' })).toBe(
      'processes not enabled for this sandbox; run: mocactl sbx mode sbx_0123abcd lease+processes',
    );
    expect(execFailureText(e, { sandboxId: 'sbx_0123abcd' })).toBe(
      'processes not enabled for this sandbox; ask the user to run: mocactl sbx mode sbx_0123abcd lease+processes',
    );
    expect(execFailureText(e, { audience: 'cli' })).toBe(
      'processes not enabled for this sandbox; run: mocactl sbx mode <id> lease+processes',
    );
  });

  it('points a person at the sbx proc commands, not the model tools (plan 5 Task 10)', () => {
    const nf = new ProcessError('process_not_found', 'web', '');
    expect(execFailureText(nf, { audience: 'cli' })).toBe(
      'no tracked process web; mocactl sbx proc ls shows them',
    );
    expect(execFailureText(nf)).toBe('no tracked process web; process_list shows them');
    const byId = new ProcessError('process_not_found', '3', 'process_not_found: 3');
    expect(execFailureText(byId, { audience: 'cli' })).toBe(
      'no tracked process p3; mocactl sbx proc ls shows them',
    );
    const lim = new ProcessError('process_limit', '4 running (SH_LEASE_MAX_PROCESSES)', '');
    expect(execFailureText(lim, { audience: 'cli' })).toBe(
      'too many tracked processes: 4 running (SH_LEASE_MAX_PROCESSES); stop one with mocactl sbx proc stop first',
    );
    expect(execFailureText(lim)).toBe(
      'too many tracked processes: 4 running (SH_LEASE_MAX_PROCESSES); stop one with process_stop first',
    );
  });
});

describe("a failed re-mint's carried events (Minor 1)", () => {
  it('ride the result of a call whose error carries them', async () => {
    let tz: string | undefined = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const AT = Date.UTC(2026, 10, 13, 14, 2, 30);
      const end = LeaseEvent.fromPartial({
        state: 'end',
        reason: 'idle',
        atUnixMs: AT,
        mode: SandboxMode.SANDBOX_MODE_LEASE,
      });
      // The token source's own error, with the first attempt's events attached by the connection.
      const boom = Object.assign(new Error('control plane unreachable'), { lease: [end] });
      const { client } = await connect({ exec: throwing(boom), mode: 'lease' });
      const r = await call(client, 'bash', { command: 'x' });
      expect(r.isError).toBe(true);
      expect(text(r).split('\n')[0]).toBe(
        '[sandbox] guest restarted (idle, 14:02): /tmp, installs outside /workspace and background processes are gone',
      );
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
      tz = undefined;
    }
  });
});
