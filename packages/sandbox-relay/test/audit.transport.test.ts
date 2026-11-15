import { Metadata, credentials, status } from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Exec, SandboxExecClient, Stream } from '@moca/k8s-sandbox';
import { makeExecAuth, startRelay } from '../src/main.js';
import { commandPreview, type AuditLine } from '../src/sandbox-caller.js';
import {
  HARNESS,
  K,
  ISS,
  abort,
  closeAll,
  closers,
  exec,
  records,
  relay,
  sleep,
  token,
  tokenB,
  worker,
  type Reply,
  wid,
} from './helpers/sandbox-relay.js';

// SBX0 §3.5 over a real grpc-js relay: one audit line per sandbox Exec, on the relay's existing
// refusal channel (`deps.log`). Each outcome is driven by what the fake worker answers, and each
// line is asserted whole, so dropping any one mapping fails a test here.

afterEach(closeAll);

/** The relay's audit lines for Execs, parsed. Abort refusals carry another `audit` value. */
const audit = (lines: string[]) =>
  lines.map((l) => JSON.parse(l) as AuditLine).filter((l) => l.audit === 'sandbox_exec');

/** A relay with a worker answering every Exec with `reply`. */
async function answering(reply: Reply, env: NodeJS.ProcessEnv = {}) {
  const r = await relay(env);
  await worker(r.attach, 'sbx_default', 'auto', 0, () => reply);
  return r;
}

const WID = (reqId: number) => wid('sbx-aaaa', reqId);

describe('one audit line per sandbox Exec (SBX0 §3.5)', () => {
  it('writes one line with the caller, the outcome and the stdout size, and no command or output', async () => {
    const r = await answering([
      { chunk: { data: 'hello' } },
      { chunk: { data: 'warn!!', stream: Stream.STREAM_STDERR } },
      { end: { exitCode: 3 } },
    ]);
    const res = await exec(r.exec, { token: token(), reqId: 7, command: 'echo hello' }).done;
    expect(res.code).toBe(status.OK);
    const lines = audit(r.lines);
    expect(lines).toEqual([
      {
        audit: 'sandbox_exec',
        ts: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        sub: 'github:1',
        sbx: 'sbx-aaaa',
        wrk: 'sbx_default',
        // The CALLER's req_id, never the worker's.
        req_id: 7,
        kind: 'command',
        ms: expect.any(Number),
        outcome: 'end',
        exit_code: 3,
        truncated: false,
        // stdout only: stderr is not output the caller asked for.
        out_bytes: 5,
      },
    ]);
    expect(lines[0]!.ms).toBeGreaterThanOrEqual(0);
    // The documented key order (spec §3.5), which a log reader may rely on.
    expect(Object.keys(lines[0]!)).toEqual([
      'audit',
      'ts',
      'sub',
      'sbx',
      'wrk',
      'req_id',
      'kind',
      'ms',
      'outcome',
      'exit_code',
      'truncated',
      'out_bytes',
    ]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).not.toContain('echo');
    expect(r.lines[0]).not.toContain('hello');
    expect(r.lines[0]).not.toContain(String(WID(7)));
  });

  it("records the worker's truncation", async () => {
    const r = await answering([
      { chunk: { data: 'abc' } },
      { end: { exitCode: 0, truncated: true } },
    ]);
    expect((await exec(r.exec, { token: token() }).done).code).toBe(status.OK);
    expect(audit(r.lines)).toEqual([
      expect.objectContaining({ outcome: 'end', exit_code: 0, truncated: true, out_bytes: 3 }),
    ]);
  });

  it.each([
    ['timeout:5', 'timeout'],
    ['timeout:0', 'timeout'],
    ['timeout:5s', 'error'],
    ['timeout:', 'error'],
    ['xtimeout:5', 'error'],
    ['boom', 'error'],
    ['', 'error'],
  ])('records a worker ExecError %j as %s', async (message, outcome) => {
    const r = await answering([{ chunk: { data: 'ab' } }, { error: { message } }]);
    const res = await exec(r.exec, { token: token(), reqId: 8 }).done;
    expect(res.code).toBe(status.INTERNAL);
    const lines = audit(r.lines);
    expect(lines).toEqual([
      expect.objectContaining({
        sub: 'github:1',
        sbx: 'sbx-aaaa',
        req_id: 8,
        outcome,
        out_bytes: 2,
      }),
    ]);
    // No exit code without an End, and the worker's message is not logged: it can quote output.
    expect(lines[0]).not.toHaveProperty('exit_code');
    expect(lines[0]).not.toHaveProperty('truncated');
    if (message) expect(r.lines[0]).not.toContain(message === 'boom' ? 'boom' : `"${message}"`);
  });

  it('records a routing failure (no live worker) as error', async () => {
    const r = await relay();
    const res = await exec(r.exec, { token: token(), reqId: 9 }).done;
    expect(res.code).not.toBe(status.OK);
    expect(audit(r.lines)).toEqual([
      expect.objectContaining({ outcome: 'error', req_id: 9, out_bytes: 0, sub: 'github:1' }),
    ]);
  });

  it('records a worker disconnect as error', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const a = exec(r.exec, { token: token(), reqId: 10 });
    await sleep(200);
    w.close();
    expect((await a.done).code).toBe(status.INTERNAL);
    expect(audit(r.lines)).toEqual([expect.objectContaining({ outcome: 'error', req_id: 10 })]);
  });

  it('records a client cancel as cancelled when it happens, even if the worker never acknowledges', async () => {
    const r = await relay();
    await worker(r.attach, 'sbx_default', 'deaf');
    const a = exec(r.exec, { token: token(), reqId: 11 });
    await sleep(200);
    a.cancel();
    expect((await a.done).code).toBe(status.CANCELLED);
    await sleep(150);
    expect(audit(r.lines)).toEqual([
      expect.objectContaining({ outcome: 'cancelled', req_id: 11, sub: 'github:1', out_bytes: 0 }),
    ]);
  });

  it('records a client cancel the worker acknowledges as one cancelled line', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const a = exec(r.exec, { token: token(), reqId: 12 });
    await sleep(200);
    a.cancel();
    expect((await a.done).code).toBe(status.CANCELLED);
    await sleep(200);
    expect(w.aborts).toEqual([WID(12)]);
    expect(audit(r.lines)).toEqual([expect.objectContaining({ outcome: 'cancelled', req_id: 12 })]);
  });

  it("records the owner's Abort as cancelled, however the worker acknowledges it", async () => {
    const r = await relay();
    await worker(r.attach, 'sbx_default', 'hold'); // acknowledges with ExecError "aborted"
    const a = exec(r.exec, { token: token(), reqId: 13 });
    await sleep(200);
    expect((await abort(r.exec, token(), 13)).code).toBe(status.OK);
    await a.done;
    expect(audit(r.lines)).toEqual([expect.objectContaining({ outcome: 'cancelled', req_id: 13 })]);
  });

  it.each(['deaf', 'hold'] as const)(
    'records expired when the expiry fires, exactly once (a %s worker)',
    async (mode) => {
      const r = await relay({}, { sandboxLeewayS: 0 });
      await worker(r.attach, 'sbx_default', mode);
      const res = await exec(r.exec, { token: token({ ttlSeconds: 1 }), reqId: 14 }).done;
      expect(res.code).toBe(status.DEADLINE_EXCEEDED);
      // A deaf worker never lets the drain finish: the line cannot wait for it.
      expect(audit(r.lines)).toEqual([
        expect.objectContaining({
          outcome: 'expired',
          req_id: 14,
          sub: 'github:1',
          sbx: 'sbx-aaaa',
        }),
      ]);
      await sleep(300);
      expect(audit(r.lines)).toHaveLength(1);
    },
  );

  it('records the in-flight cap refusal as busy', async () => {
    const r = await relay({ SH_SANDBOX_MAX_INFLIGHT: '1' });
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const one = exec(r.exec, { token: token(), reqId: 1 });
    await sleep(200);
    expect((await exec(r.exec, { token: token(), reqId: 2 }).done).code).toBe(
      status.RESOURCE_EXHAUSTED,
    );
    expect(audit(r.lines)).toEqual([
      expect.objectContaining({
        outcome: 'busy',
        req_id: 2,
        sub: 'github:1',
        sbx: 'sbx-aaaa',
        out_bytes: 0,
      }),
    ]);
    w.release(WID(1));
    await one.done;
    expect(audit(r.lines).map((l) => [l.req_id, l.outcome])).toEqual([
      [2, 'busy'],
      [1, 'end'],
    ]);
  });

  it('records a req_id already in flight for the sandbox as refused, req_id_in_flight', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const first = exec(r.exec, { token: token(), reqId: 15 });
    await sleep(200);
    expect((await exec(r.exec, { token: token(), reqId: 15 }).done).code).toBe(
      status.ALREADY_EXISTS,
    );
    expect(audit(r.lines)).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        reason: 'req_id_in_flight',
        req_id: 15,
        sub: 'github:1',
        sbx: 'sbx-aaaa',
      }),
    ]);
    w.release(WID(15));
    await first.done;
  });

  it('records PERMISSION_DENIED as refused, with its reason and the verified sub and sbx', async () => {
    const r = await relay();
    await worker(r.attach, 'sbx_default');
    await exec(r.exec, { token: token(), wsk: 'sbx-bbbb', reqId: 16 }).done;
    expect(audit(r.lines)).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        reason: "exec not permitted: workspace_key is not this token's workspace",
        sub: 'github:1',
        sbx: 'sbx-aaaa',
        wrk: 'sbx_default',
        req_id: 16,
        out_bytes: 0,
      }),
    ]);
  });

  it('records UNAUTHENTICATED as refused with the verifier reason and NO sub or sbx, even when the token parsed', async () => {
    const r = await relay({ SH_SANDBOX_AUDIT_COMMANDS: '1' });
    await worker(r.attach, 'sbx_default');
    // A well-formed token from the wrong issuer: its payload names sub and sbx, but nothing about
    // it verified, so both are the caller's own claims, and so is its command.
    await exec(r.exec, { token: token({ iss: 'mallory' }), reqId: 17, command: 'id' }).done;
    await exec(r.exec, { token: 'garbage', reqId: 18 }).done;
    const lines = audit(r.lines);
    expect(lines.map((l) => [l.outcome, l.reason, l.req_id])).toEqual([
      ['refused', 'wrong token issuer', 17],
      ['refused', 'malformed token', 18],
    ]);
    for (const l of lines) {
      expect(l).not.toHaveProperty('sub');
      expect(l).not.toHaveProperty('sbx');
      expect(l).not.toHaveProperty('cmd');
    }
  });

  it('records a sandbox caller with no exec in its request as refused', async () => {
    const r = await relay();
    const client = new SandboxExecClient(r.exec, credentials.createInsecure());
    closers.push(() => client.close());
    const md = new Metadata();
    md.set('authorization', `Bearer ${token()}`);
    const code = await new Promise<number>((resolve) => {
      const call = client.exec({ sandboxId: 'sbx_default', workload: '', exec: undefined }, md);
      call.on('error', () => {});
      call.on('data', () => {});
      call.on('status', (s: { code: number }) => resolve(s.code));
    });
    expect(code).toBe(status.INVALID_ARGUMENT);
    expect(audit(r.lines)).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        reason: 'ExecRequest missing exec field',
        sub: 'github:1',
        req_id: 0,
      }),
    ]);
  });

  it('clips a caller-chosen sandbox_id in the line, so one request cannot write a huge one', async () => {
    const r = await relay();
    await exec(r.exec, { token: 'garbage', sandboxId: 'x'.repeat(5000) }).done;
    const [line] = audit(r.lines);
    expect(Buffer.byteLength(line!.wrk)).toBeLessThanOrEqual(128);
    expect(line!.wrk.startsWith('xxxx')).toBe(true);
  });

  it('keeps Abort refusals out of the Exec lines', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const running = exec(r.exec, { token: token(), reqId: 19 });
    await sleep(200);
    expect((await abort(r.exec, tokenB(), 19)).code).toBe(status.PERMISSION_DENIED);
    const parsed = r.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toEqual([
      expect.objectContaining({
        audit: 'sandbox_abort',
        outcome: 'refused',
        sub: 'github:2',
        sbx: 'sbx-bbbb',
        req_id: 19,
      }),
    ]);
    w.release(WID(19));
    await running.done;
    expect(audit(r.lines).map((l) => l.outcome)).toEqual(['end']);
  });
});

describe('the command in the audit line (SBX0 §3.5)', () => {
  it('adds the command only with SH_SANDBOX_AUDIT_COMMANDS=1', async () => {
    const r = await answering([{ end: { exitCode: 0 } }], { SH_SANDBOX_AUDIT_COMMANDS: '1' });
    await exec(r.exec, { token: token(), command: 'echo hi' }).done;
    expect(audit(r.lines)).toEqual([expect.objectContaining({ outcome: 'end', cmd: 'echo hi' })]);
  });

  it.each(['0', 'true', 'yes', ''])('treats SH_SANDBOX_AUDIT_COMMANDS=%j as off', async (v) => {
    const r = await answering([{ end: { exitCode: 0 } }], { SH_SANDBOX_AUDIT_COMMANDS: v });
    await exec(r.exec, { token: token(), command: 'echo hi' }).done;
    const lines = audit(r.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toHaveProperty('cmd');
  });

  it('logs at most the first 200 bytes, cut on a UTF-8 character boundary', async () => {
    const long = 'a' + 'é'.repeat(150); // 301 bytes; byte 200 is inside an 'é'
    const r = await answering([{ end: { exitCode: 0 } }], { SH_SANDBOX_AUDIT_COMMANDS: '1' });
    await exec(r.exec, { token: token(), command: long }).done;
    const cmd = audit(r.lines)[0]!.cmd!;
    expect(Buffer.byteLength(cmd)).toBe(199);
    expect(cmd).toBe('a' + 'é'.repeat(99));
    expect(cmd.endsWith('\uFFFD')).toBe(false);
  });

  it('commandPreview keeps a short command whole, and cuts a long one on a boundary', () => {
    expect(commandPreview('echo hi')).toBe('echo hi');
    expect(commandPreview('x'.repeat(200))).toBe('x'.repeat(200));
    expect(commandPreview('x'.repeat(201))).toBe('x'.repeat(200));
    const cut = commandPreview('a' + 'é'.repeat(150));
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(200);
    expect(cut.endsWith('\uFFFD')).toBe(false);
    // A 4-byte character straddling the cut is dropped whole.
    expect(commandPreview('x'.repeat(198) + '😀')).toBe('x'.repeat(198));
  });

  it('makeExecAuth reads the flag on a relay with sandbox keys only', () => {
    const keys = { SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset, SH_SANDBOX_TOKEN_ISSUER: ISS };
    expect(makeExecAuth({ ...keys, SH_SANDBOX_AUDIT_COMMANDS: '1' }).sandboxAuditCommands).toBe(
      true,
    );
    expect(makeExecAuth(keys).sandboxAuditCommands).toBeUndefined();
    expect(
      makeExecAuth({ MOCA_RELAY_EXEC_TOKEN: HARNESS, SH_SANDBOX_AUDIT_COMMANDS: '1' })
        .sandboxAuditCommands,
    ).toBeUndefined();
  });
});

describe('an audit sink that throws (SBX0 §3.5)', () => {
  it('never stops enforcement: the slot is released and the next Exec is admitted', async () => {
    const r = await relay(
      { SH_SANDBOX_MAX_INFLIGHT: '1' },
      {
        log: () => {
          throw new Error('disk full');
        },
      },
    );
    await worker(r.attach, 'sbx_default', 'auto', 0, () => [{ end: { exitCode: 0 } }]);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await exec(r.exec, { token: token(), reqId: 1 }).done).code).toBe(status.OK);
      // With the in-flight cap at 1, a slot leaked by a throwing write would refuse this one.
      expect((await exec(r.exec, { token: token(), reqId: 2 }).done).code).toBe(status.OK);
      expect(quiet.mock.calls.join(' ')).toContain('audit line not written: disk full');
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('a MOCA relay writes no audit lines (SBX0 §3.5)', () => {
  it('without sandbox keys: harness Execs and refusals print nothing', async () => {
    const lines: string[] = [];
    const r = await startRelay({
      port: 0,
      execAddr: '127.0.0.1:0',
      deps: {
        records,
        validateToken: () => true,
        ...makeExecAuth({ MOCA_RELAY_EXEC_TOKEN: HARNESS, SH_SANDBOX_AUDIT_COMMANDS: '1' }),
        log: (l) => lines.push(l),
      },
    });
    closers.push(r.shutdown);
    const addr = `127.0.0.1:${r.execPort}`;
    await worker(`127.0.0.1:${r.port}`, 'sbx_default');
    expect((await exec(addr, { token: HARNESS, wsk: 'run-1' }).done).code).toBe(status.OK);
    expect((await exec(addr, { token: token() }).done).code).toBe(status.UNAUTHENTICATED);
    expect((await exec(addr, { token: 'garbage' }).done).code).toBe(status.UNAUTHENTICATED);
    expect(lines).toEqual([]);
  });

  it('beside sandbox keys: a harness Exec writes no line', async () => {
    const r = await relay({ MOCA_RELAY_EXEC_TOKEN: HARNESS });
    await worker(r.attach, 'sbx_default');
    expect((await exec(r.exec, { token: HARNESS, wsk: 'run-1' }).done).code).toBe(status.OK);
    expect(r.lines).toEqual([]);
  });
});

describe('the audit line for a req_id the worker id cannot be derived from', () => {
  // Unreachable over the wire (the generated decoder refuses a uint64 past 2^53 before the handler
  // runs), so the registered handler is driven with a fake call, as in sandbox-auth.test.ts.
  it('records INVALID_ARGUMENT as refused', async () => {
    const { EventEmitter } = await import('node:events');
    const { buildServer } = await import('../src/main.js');
    const lines: string[] = [];
    const claims = {
      iss: ISS,
      aud: 'moca-sandbox',
      sub: 'github:1',
      tenant: 'github:1',
      sbx: 'sbx-aaaa',
      wrk: 'sbx_default',
      wsk: 'sbx-aaaa',
      scope: ['exec'],
      mode: 'per-exec' as const,
      mode_epoch: 0,
      idle_timeout_s: 0,
      iat: 0,
      exp: 0,
      jti: 'j',
    };
    const { server } = buildServer({
      records,
      validateToken: () => true,
      validateExecToken: () => false,
      verifySandboxToken: () => ({ claims }),
      log: (l) => lines.push(l),
    });
    const errors: Array<{ code: number }> = [];
    const call = Object.assign(new EventEmitter(), {
      request: {
        sandboxId: 'sbx_default',
        exec: Exec.fromPartial({ reqId: -1, command: 'true', workspaceKey: 'sbx-aaaa' }),
      },
      metadata: { get: () => ['Bearer x'] },
      write() {},
      end() {},
    });
    call.on('error', (e: { code: number }) => errors.push(e));
    const handlers = (
      server as unknown as { handlers: Map<string, { func: (c: unknown) => unknown }> }
    ).handlers;
    await handlers.get('/sandbox.v1.SandboxExec/Exec')!.func(call);
    expect(errors.map((e) => e.code)).toEqual([status.INVALID_ARGUMENT]);
    expect(audit(lines)).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        reason: 'req_id out of range',
        req_id: -1,
        sub: 'github:1',
        sbx: 'sbx-aaaa',
      }),
    ]);
  });
});

describe('pumpExec reports how the Exec went (SBX0 §3.5)', () => {
  // A fake call and relay: the result is what the audit line is built from, so each field is
  // pinned here directly rather than only through a line.
  async function pumped(frames: Array<Record<string, unknown>>, cancelFirst = false) {
    const { EventEmitter } = await import('node:events');
    const { pumpExec } = await import('../src/exec-stream.js');
    const call = Object.assign(new EventEmitter(), { write() {}, end() {} });
    call.on('error', () => {});
    const aborts: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fake = {
      async *routeExec() {
        if (cancelFirst) await gate;
        for (const f of frames) yield f;
      },
      routeAbort: (_s: string, id: number) => {
        aborts.push(id);
        release();
      },
    };
    const done = pumpExec(call as never, fake as never, 'sbx_default', { reqId: 5 } as never);
    if (cancelFirst) call.emit('cancelled');
    return { result: await done, aborts };
  }

  it('counts stdout bytes only, and keeps the End', async () => {
    const { result } = await pumped([
      { chunk: { reqId: 5, data: Buffer.from('abcd'), stream: Stream.STREAM_STDOUT } },
      { chunk: { reqId: 5, data: Buffer.from('zz'), stream: Stream.STREAM_STDERR } },
      { end: { reqId: 5, exitCode: 2, truncated: true } },
    ]);
    expect(result).toEqual({
      outBytes: 4,
      end: { reqId: 5, exitCode: 2, truncated: true },
      cancelled: false,
    });
  });

  it('keeps an ExecError message, even an empty one', async () => {
    const { result } = await pumped([{ error: { reqId: 5, message: '' } }]);
    expect(result).toEqual({ outBytes: 0, execError: '', cancelled: false });
  });

  it('records a client cancel', async () => {
    const { result, aborts } = await pumped([{ error: { reqId: 5, message: 'aborted' } }], true);
    expect(aborts).toEqual([5]);
    expect(result).toEqual({ outBytes: 0, execError: 'aborted', cancelled: true });
  });
});
