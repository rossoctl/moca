import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ExecMachineryError,
  ExecRefusedError,
  type Exec,
  type ExecResult,
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
  return { client, records };
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
  /** A lease fake that answers `status` from `states` in turn (the last repeats) and records ops. */
  const leaseFake = (...states: LeaseStatusView[]) => {
    const ops: string[] = [];
    let i = 0;
    const lease = async (op: 'status' | 'reset') => {
      ops.push(op);
      if (op === 'reset') return NO_LEASE;
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
    });
    const r = await call(client, 'reset', {});
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('lease ended (reset): the next command starts a new guest');
    expect(f.ops).toEqual(['status', 'reset']);
    expect(sent).toEqual([]);
    expect(records).toMatchObject([{ tool: 'reset', execs: 0, ok: true }]);
  });

  it('reset with no lease', async () => {
    const f = leaseFake(NO_LEASE);
    const { client } = await connect({ exec: async () => res(), lease: f.lease });
    expect(text(await call(client, 'reset', {}))).toBe('no lease to reset');
    expect(f.ops).toEqual(['status']);
  });

  it('a failed reset is a tool error naming the code', async () => {
    const { client } = await connect({
      exec: async () => res(),
      lease: async (op) => {
        if (op === 'status') return ACTIVE;
        throw new LeaseControlError('timeout', 'deadline exceeded');
      },
    });
    const r = await call(client, 'reset', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('the lease call failed (timeout): deadline exceeded');
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
    const { client: c2 } = await connect({ exec, lease: zero.lease });
    expect(text(await call(c2, 'sandbox_info', {}))).toContain(
      '\nidle timeout: 0s (the worker default)\n',
    );
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
        'tracked processes: none',
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
    expect(sandboxRules('/workspace', 'lease+processes')).toBe(sandboxRules('/workspace', 'lease'));
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
