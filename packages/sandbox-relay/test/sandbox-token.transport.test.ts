import { status } from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import { SANDBOX_TOKEN_TYP, mintAttachToken } from '@moca/control-plane';
import { makeAttachVerifier, makeExecAuth, startRelay } from '../src/main.js';
import {
  HARNESS,
  K,
  abort,
  b64u,
  claims,
  closeAll,
  closers,
  exec,
  idsOf,
  keypair,
  now,
  reasons,
  records,
  relay,
  sleep,
  stdoutOf,
  token,
  tokenB,
  worker,
  wid,
} from './helpers/sandbox-relay.js';

// SBX0 §3.2 / §3.6 / §10.2 over a REAL grpc-js server and client. Every refusal happens BEFORE
// routing: the attached fake worker records each Exec and Abort it receives, and a refused call
// leaves no trace there. Each refusal is asserted by its status code AND a reason-specific detail
// (PERMISSION_DENIED, RESOURCE_EXHAUSTED) or refusal-log reason (UNAUTHENTICATED, whose details
// deliberately say nothing), so removing any single check fails at least one test.

afterEach(closeAll);

describe('the relay sandbox caller (SBX0 §3.2)', () => {
  it('runs an Exec for a valid token on its own worker and workspace', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const res = await exec(r.exec, { token: token(), reqId: 7 }).done;
    expect(res.code).toBe(status.OK);
    expect(w.execs).toHaveLength(1);
    expect(stdoutOf(res.events)).toBe('sbx-aaaa');
  });

  it('accepts a token expired by less than the 30 s leeway', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const t = token({ now: now() - 600, ttlSeconds: 590 }); // exp = now - 10
    expect((await exec(r.exec, { token: t }).done).code).toBe(status.OK);
    expect(w.execs).toHaveLength(1);
  });

  const forged: Record<'algNone' | 'tamperedSig', () => string> = {
    algNone: () =>
      `${b64u({ alg: 'none', typ: SANDBOX_TOKEN_TYP, kid: K.signer.kid })}.${b64u(claims())}.${b64u('sig')}`,
    tamperedSig: () => {
      const [h, p, s] = token().split('.') as [string, string, string];
      const sig = Buffer.from(s, 'base64url');
      sig[0] = sig[0]! ^ 0xff;
      return `${h}.${p}.${sig.toString('base64url')}`;
    },
  };

  it.each([
    ['no token', () => undefined, /^no bearer token$/],
    ['a garbage token', () => 'a.b', /^malformed token$/],
    ['alg: none, with a signature segment', forged.algNone, /^unsupported alg$/],
    ['an unknown kid', () => token({}, keypair().signer), /^unknown token key id$/],
    ['the wrong typ', () => K.signer.signJws('JWT', claims()), /^wrong token typ/],
    [
      'the wrong aud',
      () => K.signer.signJws(SANDBOX_TOKEN_TYP, claims({ aud: 'harness' })),
      /^wrong token audience$/,
    ],
    ['the wrong iss', () => token({ iss: 'mallory' }), /^wrong token issuer$/],
    [
      'a token expired beyond the leeway',
      () => token({ now: now() - 600, ttlSeconds: 560 }),
      /^token expired$/,
    ],
    [
      'a missing exec scope',
      () => K.signer.signJws(SANDBOX_TOKEN_TYP, claims({ scope: ['files:read'] })),
      /^token scope does not include exec$/,
    ],
    ['a tampered signature', forged.tamperedSig, /^bad token signature$/],
    [
      'an API token presented as a sandbox token',
      () =>
        K.signer.mint({
          sub: 'github:1',
          tenant: 'github:1',
          roles: [],
          scope: ['api', 'exec'],
          ttlSeconds: 900,
        }),
      /^wrong token typ/,
    ],
    [
      'a session token presented as a sandbox token',
      () =>
        K.signer.mint({
          sub: 'github:1',
          tenant: 'github:1',
          roles: [],
          scope: ['exec'],
          ttlSeconds: 900,
          sid: 's-1',
        }),
      /^wrong token typ/,
    ],
  ] as Array<[string, () => string | undefined, RegExp]>)(
    'refuses an Exec with %s, UNAUTHENTICATED, before routing',
    async (_name, make, why) => {
      const r = await relay();
      const w = await worker(r.attach, 'sbx_default');
      const t = make();
      const res = await exec(r.exec, { token: t }).done;
      expect(res.code).toBe(status.UNAUTHENTICATED);
      // The caller learns nothing; the operator's log line carries the reason, never the token.
      expect(res.details).toBe('exec authentication failed');
      const refused = reasons(r.lines).filter((l) => l.outcome === 'refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ audit: 'sandbox_exec' });
      // Nothing about the token verified, so its sub and sbx are not the caller's to claim.
      expect(refused[0]).not.toHaveProperty('sub');
      expect(refused[0]).not.toHaveProperty('sbx');
      expect(refused[0]!.reason).toMatch(why);
      if (t)
        for (const part of t.split('.'))
          if (part.length > 8) expect(r.lines.join('')).not.toContain(part);
      expect(w.execs).toHaveLength(0);
    },
  );

  it.each([
    ['another worker', { sandboxId: 'sbx_node22' }, /sandbox_id is not this token's worker/],
    ['another workspace', { wsk: 'sbx-bbbb' }, /workspace_key is not this token's workspace/],
    [
      'a prefix of the workspace key',
      { wsk: 'sbx-aaa' },
      /workspace_key is not this token's workspace/,
    ],
    [
      'an extension of the workspace key',
      { wsk: 'sbx-aaaa-x' },
      /workspace_key is not this token's workspace/,
    ],
    ['an empty workspace key', { wsk: '' }, /workspace_key is not this token's workspace/],
  ] as const)(
    'refuses an Exec on %s, PERMISSION_DENIED, before routing',
    async (_name, opts, why) => {
      const r = await relay();
      const w = await worker(r.attach, 'sbx_default');
      const other = await worker(r.attach, 'sbx_node22');
      const res = await exec(r.exec, { ...opts, token: token() }).done;
      expect(res.code).toBe(status.PERMISSION_DENIED);
      expect(res.details).toMatch(why);
      expect(reasons(r.lines)).toEqual([
        expect.objectContaining({
          outcome: 'refused',
          audit: 'sandbox_exec',
          sbx: 'sbx-aaaa',
          reason: expect.stringMatching(why),
        }),
      ]);
      expect(w.execs).toHaveLength(0);
      expect(other.execs).toHaveLength(0);
    },
  );

  it("refuses to Abort another sandbox's Exec, and allows the owner's", async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const running = exec(r.exec, { token: token(), reqId: 4242 });
    await sleep(200);
    const denied = await abort(r.exec, tokenB(), 4242);
    expect(denied.code).toBe(status.PERMISSION_DENIED);
    expect(denied.details).toMatch(/not an in-flight Exec of this sandbox/);
    expect(w.aborts).toHaveLength(0);
    expect((await abort(r.exec, token(), 4242)).code).toBe(status.OK);
    expect((await running.done).code).not.toBe(status.OK);
    expect(w.aborts).toEqual([wid('sbx-aaaa', 4242)]);
  });

  it('refuses to Abort a finished Exec: its ownership entry is gone', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    expect((await exec(r.exec, { token: token(), reqId: 31 }).done).code).toBe(status.OK);
    const denied = await abort(r.exec, token(), 31);
    expect(denied.code).toBe(status.PERMISSION_DENIED);
    expect(denied.details).toMatch(/not an in-flight Exec of this sandbox/);
    expect(w.aborts).toHaveLength(0);
  });

  it('refuses an Abort for the right req_id on another worker', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const n22 = await worker(r.attach, 'sbx_node22', 'hold');
    const running = exec(r.exec, { token: token(), reqId: 55 });
    await sleep(200);
    const denied = await abort(r.exec, token(), 55, 'sbx_node22');
    expect(denied.code).toBe(status.PERMISSION_DENIED);
    expect(w.aborts).toHaveLength(0);
    expect(n22.aborts).toHaveLength(0);
    w.release(wid('sbx-aaaa', 55));
    expect((await running.done).code).toBe(status.OK);
  });

  it('refuses an Abort with a token that does not verify, UNAUTHENTICATED, with its reason logged', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const running = exec(r.exec, { token: token(), reqId: 66 });
    await sleep(200);
    const res = await abort(r.exec, token({ iss: 'mallory' }), 66);
    expect(res.code).toBe(status.UNAUTHENTICATED);
    expect(reasons(r.lines)).toEqual([
      expect.objectContaining({ audit: 'sandbox_abort', reason: 'wrong token issuer' }),
    ]);
    expect(w.aborts).toHaveLength(0);
    w.release(wid('sbx-aaaa', 66));
    expect((await running.done).code).toBe(status.OK);
  });
});

describe('sandbox callers and workload sandboxes (workload sandboxes spec §3.3)', () => {
  // Deliberate: a sandbox caller's Exec carries no workload (sandbox-caller.ts passes none to
  // pumpExec), so with attach keys set it can never reach a workload sandbox, even one its token's
  // `wrk` names and even when its request fills in the workload field.
  it.each([
    ['no workload', undefined],
    ["the sandbox's own workload", `w-${'a'.repeat(32)}`],
  ])(
    'refuses an Exec naming %s on a workload sandbox, PERMISSION_DENIED, before routing',
    async (_name, workload) => {
      const WL = `w-${'a'.repeat(32)}`;
      const A = keypair();
      const attachToken = mintAttachToken(A.signer, {
        wl: WL,
        own: 'b'.repeat(32),
        gen: 'g1',
        tr: 'container',
        n: 1,
        now: now(),
        ttlSeconds: 600,
      });
      const r = await relay(
        {},
        {
          validateToken: () => false,
          verifyAttach: makeAttachVerifier({ MOCA_ATTACH_PUBLIC_KEYS: A.keyset })!,
        },
      );
      const w = await worker(r.attach, `${WL}-0`, 'auto', 0, undefined, attachToken);
      const res = await exec(r.exec, {
        token: token({ wrk: `${WL}-0` }),
        sandboxId: `${WL}-0`,
        ...(workload ? { workload } : {}),
      }).done;
      expect(res.code).toBe(status.PERMISSION_DENIED);
      expect(res.details).toMatch(/belongs to a workload this Exec does not name/);
      expect(w.execs).toHaveLength(0);
    },
  );
});

describe('sandbox Execs: per-sandbox request ids (SBX0 §3.6)', () => {
  it('runs the same req_id and command from two sandboxes as two worker Execs, each seeing only its own frames', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 300);
    const a = exec(r.exec, { token: token(), reqId: 7, command: 'echo hi' });
    const b = exec(r.exec, { token: tokenB(), reqId: 7, command: 'echo hi', wsk: 'sbx-bbbb' });
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra.code).toBe(status.OK);
    expect(rb.code).toBe(status.OK);
    const wa = wid('sbx-aaaa', 7);
    const wb = wid('sbx-bbbb', 7);
    expect(wa).not.toBe(wb);
    expect(w.execs.map((e) => e.reqId).sort()).toEqual([wa, wb].sort());
    // Nothing else of the Exec is rewritten: the worker's dedup fingerprint is the caller's.
    expect(w.execs.map((e) => e.command)).toEqual(['echo hi', 'echo hi']);
    // Each caller gets its own frames, all carrying ITS req_id, never the worker's.
    expect(stdoutOf(ra.events)).toBe('sbx-aaaa');
    expect(stdoutOf(rb.events)).toBe('sbx-bbbb');
    expect(idsOf(ra.events)).toEqual([7, 7]);
    expect(idsOf(rb.events)).toEqual([7, 7]);
  });

  it("maps B's Abort of a shared req_id to B's own Exec, never A's", async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const a = exec(r.exec, { token: token(), reqId: 9 });
    const b = exec(r.exec, { token: tokenB(), reqId: 9, wsk: 'sbx-bbbb' });
    await sleep(200);
    expect((await abort(r.exec, tokenB(), 9)).code).toBe(status.OK);
    const rb = await b.done;
    expect(w.aborts).toEqual([wid('sbx-bbbb', 9)]);
    // B's abort acknowledgement comes back under B's id.
    expect(idsOf(rb.events)).toEqual([9]);
    expect(rb.events[0]?.error?.message).toBe('aborted');
    // A is still running, and finishes normally.
    w.release(wid('sbx-aaaa', 9));
    const ra = await a.done;
    expect(ra.code).toBe(status.OK);
    expect(idsOf(ra.events)).toEqual([9, 9]);
  });

  it('rewrites the worker error frame back to the caller id, and still ends non-OK', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const a = exec(r.exec, { token: token(), reqId: 12 });
    await sleep(200);
    w.close(); // the worker disconnects: the relay fails the Exec with an in-stream error
    const ra = await a.done;
    expect(ra.code).toBe(status.INTERNAL);
    expect(ra.details).toBe('worker disconnected');
    expect(idsOf(ra.events)).toEqual([12]);
  });

  it('refuses a second Exec with a req_id already in flight for the same sandbox, without leaking the worker id', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const first = exec(r.exec, { token: token(), reqId: 13 });
    await sleep(200);
    const dup = await exec(r.exec, { token: token(), reqId: 13 }).done;
    expect(dup.code).toBe(status.ALREADY_EXISTS);
    expect(dup.details).not.toContain(String(wid('sbx-aaaa', 13)));
    expect(w.execs).toHaveLength(1);
    w.release(wid('sbx-aaaa', 13));
    expect((await first.done).code).toBe(status.OK);
  });

  it("reports a worker-side req_id collision in the caller's id, not the worker's", async () => {
    // A harness Exec that happens to hold the sandbox's worker id: the routing collision's message
    // names the id it collided on, which the sandbox caller must only ever see as its own.
    const r = await relay({ MOCA_RELAY_EXEC_TOKEN: HARNESS });
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const id = wid('sbx-aaaa', 14);
    const harness = exec(r.exec, { token: HARNESS, reqId: id, wsk: 'run-1' });
    await sleep(200);
    const res = await exec(r.exec, { token: token(), reqId: 14 }).done;
    expect(res.code).not.toBe(status.OK);
    expect(res.details).toMatch(/req_id 14 already in flight/);
    expect(res.details).not.toContain(String(id));
    w.release(id);
    expect((await harness.done).code).toBe(status.OK);
  });

  it('forwards a client cancel to the worker under the worker id', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const a = exec(r.exec, { token: token(), reqId: 15 });
    await sleep(200);
    a.cancel();
    expect((await a.done).code).toBe(status.CANCELLED);
    await sleep(100);
    expect(w.aborts).toEqual([wid('sbx-aaaa', 15)]);
  });
});

describe('sandbox Execs: no Exec outlives its token (SBX0 §3.6)', () => {
  // `deaf` never answers; `hold` acknowledges the Abort with an ExecError, which arrives after the
  // call has ended and must not reach the caller.
  it.each(['deaf', 'hold'] as const)(
    'aborts at exp + leeway and ends DEADLINE_EXCEEDED (a %s worker)',
    async (mode) => {
      const r = await relay({}, { sandboxLeewayS: 0 });
      const w = await worker(r.attach, 'sbx_default', mode);
      const t = token({ ttlSeconds: 1 });
      const started = Date.now();
      const a = exec(r.exec, { token: t, reqId: 21 });
      const res = await a.done;
      expect(res.code).toBe(status.DEADLINE_EXCEEDED);
      expect(res.details).toBe('sandbox token expired during the Exec');
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(res.events).toHaveLength(0);
      await sleep(200);
      // Exactly one Abort: grpc-js reports the call it ended as cancelled, which must not send a
      // second one.
      expect(w.aborts).toEqual([wid('sbx-aaaa', 21)]);
      if (mode === 'hold') {
        // The relay is sound afterwards: the next Exec runs, under its own id.
        const next = exec(r.exec, { token: token(), reqId: 24 });
        await sleep(200);
        w.release(wid('sbx-aaaa', 24));
        const done = await next.done;
        expect(done.code).toBe(status.OK);
        expect(idsOf(done.events)).toEqual([24, 24]);
      }
    },
  );

  it('honours the leeway: still running one second past exp with the default 30 s', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const a = exec(r.exec, { token: token({ ttlSeconds: 1 }), reqId: 22 });
    await sleep(2_200);
    expect(w.aborts).toHaveLength(0);
    w.release(wid('sbx-aaaa', 22));
    expect((await a.done).code).toBe(status.OK);
  });

  it('clears the timer when the Exec ends first: no late Abort reaches the worker', async () => {
    const r = await relay({}, { sandboxLeewayS: 0 });
    const w = await worker(r.attach, 'sbx_default');
    // ttlSeconds: 2, not 1, and the whole point is that the Exec must finish BEFORE exp. `exp` is
    // `Math.floor(Date.now() / 1000) + ttlSeconds`, so a ttl of 1 leaves anywhere from 1 ms to 1 s
    // of real budget depending on where in the second the token is minted -- with leeway 0 that
    // failed in CI as DEADLINE_EXCEEDED. Two seconds guarantees at least one.
    expect((await exec(r.exec, { token: token({ ttlSeconds: 2 }), reqId: 23 }).done).code).toBe(
      status.OK,
    );
    // Past exp either way: at most 2 s of it was left when the Exec ended.
    await sleep(2_500);
    expect(w.aborts).toHaveLength(0);
  });

  it('holds no expiry timer once an Exec has ended, on any path', async () => {
    // A timer left armed keeps the Exec's closure (its call, its claims) alive until exp, and for a
    // long token its whole lifetime: counted here, not inferred from a late Abort.
    const live = new Set<unknown>();
    const timers = {
      setTimeout: (fn: () => void, ms: number) => {
        const h: ReturnType<typeof setTimeout> = setTimeout(() => {
          live.delete(h);
          fn();
        }, ms);
        live.add(h);
        return h;
      },
      clearTimeout: (h: unknown) => {
        live.delete(h);
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
    };
    const r = await relay({}, { timers });
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const ended = exec(r.exec, { token: token(), reqId: 1 });
    const cancelled = exec(r.exec, { token: token(), reqId: 2 });
    await sleep(200);
    expect(live.size).toBe(2);
    w.release(wid('sbx-aaaa', 1));
    expect((await ended.done).code).toBe(status.OK);
    cancelled.cancel();
    expect((await cancelled.done).code).toBe(status.CANCELLED);
    await sleep(100);
    expect(live.size).toBe(0);
  });
});

describe('sandbox Execs: the in-flight cap (SBX0 §3.6)', () => {
  it('admits two, refuses a third RESOURCE_EXHAUSTED before routing, and admits again after one ends', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const one = exec(r.exec, { token: token(), reqId: 1 });
    const two = exec(r.exec, { token: token(), reqId: 2 });
    await sleep(200);
    const three = await exec(r.exec, { token: token(), reqId: 3 }).done;
    expect(three.code).toBe(status.RESOURCE_EXHAUSTED);
    expect(three.details).toBe('sandbox busy: 2 Execs already in flight');
    expect(w.execs).toHaveLength(2);
    // The cap is per sandbox: another sandbox on the same worker is unaffected.
    const other = exec(r.exec, { token: tokenB(), reqId: 3, wsk: 'sbx-bbbb' });
    await sleep(200);
    expect(w.execs).toHaveLength(3);
    w.release(wid('sbx-aaaa', 1));
    expect((await one.done).code).toBe(status.OK);
    const four = exec(r.exec, { token: token(), reqId: 4 });
    await sleep(200);
    expect(w.execs.map((e) => e.reqId)).toContain(wid('sbx-aaaa', 4));
    w.release(wid('sbx-aaaa', 4));
    w.release(wid('sbx-aaaa', 2));
    w.release(wid('sbx-bbbb', 3));
    expect((await four.done).code).toBe(status.OK);
    expect((await two.done).code).toBe(status.OK);
    expect((await other.done).code).toBe(status.OK);
  });

  it('reads the cap from SH_SANDBOX_MAX_INFLIGHT', async () => {
    const r = await relay({ SH_SANDBOX_MAX_INFLIGHT: '1' });
    const w = await worker(r.attach, 'sbx_default', 'hold');
    const one = exec(r.exec, { token: token(), reqId: 1 });
    await sleep(200);
    const two = await exec(r.exec, { token: token(), reqId: 2 }).done;
    expect(two.code).toBe(status.RESOURCE_EXHAUSTED);
    expect(two.details).toBe('sandbox busy: 1 Execs already in flight');
    w.release(wid('sbx-aaaa', 1));
    expect((await one.done).code).toBe(status.OK);
  });

  // Cap 1, so a slot leaked on any path refuses the next Exec. The `hold` worker answers an Abort
  // with an ExecError, as the Go worker does, which is what lets a cancelled or expired Exec drain.
  it.each([
    ['an end', 'end'],
    ['a worker error', 'error'],
    ['a client cancel', 'cancel'],
    ['a worker disconnect', 'disconnect'],
    ['token expiry', 'expiry'],
    ['a refusal', 'refusal'],
  ] as const)('frees the slot after %s', async (_name, path) => {
    const r = await relay({ SH_SANDBOX_MAX_INFLIGHT: '1' }, { sandboxLeewayS: 0 });
    let w = await worker(r.attach, 'sbx_default', 'hold');
    const first = exec(r.exec, {
      token: token({ ttlSeconds: path === 'expiry' ? 1 : 900 }),
      reqId: 1,
      wsk: path === 'refusal' ? 'sbx-other' : 'sbx-aaaa',
    });
    await sleep(200);
    if (path === 'end') w.release(wid('sbx-aaaa', 1));
    if (path === 'error') await abort(r.exec, token(), 1); // answered with an ExecError
    if (path === 'cancel') first.cancel();
    if (path === 'disconnect') w.close();
    const ended = await first.done;
    expect(ended.code).toBe(
      {
        end: status.OK,
        error: status.INTERNAL,
        cancel: status.CANCELLED,
        disconnect: status.INTERNAL,
        expiry: status.DEADLINE_EXCEEDED,
        refusal: status.PERMISSION_DENIED,
      }[path],
    );
    if (path === 'disconnect') w = await worker(r.attach, 'sbx_default', 'hold');
    await sleep(150);
    const next = exec(r.exec, { token: token(), reqId: 2 });
    await sleep(200);
    expect(w.execs.map((e) => e.reqId)).toContain(wid('sbx-aaaa', 2));
    w.release(wid('sbx-aaaa', 2));
    expect((await next.done).code).toBe(status.OK);
  });
});

describe('harness callers are unchanged beside sandbox keys (SBX0 §3.1)', () => {
  it('checks the harness token first: a value that is both is a harness caller, unrestricted', async () => {
    // Contrived (no operator sets a sandbox token as the exec token), but it is the only way to
    // observe the order: harness first (spec §3.1), so nothing is checked or rewritten.
    const both = token();
    const r = await relay({ MOCA_RELAY_EXEC_TOKEN: both });
    const w = await worker(r.attach, 'sbx_node22');
    const res = await exec(r.exec, {
      token: both,
      sandboxId: 'sbx_node22',
      wsk: 'run-1',
      reqId: 77,
    }).done;
    expect(res.code).toBe(status.OK);
    expect(w.execs.map((e) => e.reqId)).toEqual([77]);
  });

  it('forwards the harness req_id as-is, with no cap and no ownership rule', async () => {
    const r = await relay({ MOCA_RELAY_EXEC_TOKEN: HARNESS, SH_SANDBOX_MAX_INFLIGHT: '1' });
    const w = await worker(r.attach, 'sbx_default', 'auto', 200);
    const runs = [1, 2, 3].map((n) =>
      exec(r.exec, { token: HARNESS, reqId: 900 + n, wsk: `run-${n}` }),
    );
    const results = await Promise.all(runs.map((x) => x.done));
    expect(results.map((x) => x.code)).toEqual([status.OK, status.OK, status.OK]);
    expect(w.execs.map((e) => e.reqId).sort()).toEqual([901, 902, 903]);
    expect(results.map((x) => idsOf(x.events))).toEqual([
      [901, 901],
      [902, 902],
      [903, 903],
    ]);
    // An unrestricted Abort, under the id it names, and no refusal lines for a harness caller.
    expect((await abort(r.exec, HARNESS, 12345, 'sbx_node22')).code).toBe(status.OK);
    expect(r.lines).toEqual([]);
  });

  it('writes no refusal lines on a relay without sandbox keys', async () => {
    const lines: string[] = [];
    const r = await startRelay({
      port: 0,
      execAddr: '127.0.0.1:0',
      deps: {
        records,
        validateToken: () => true,
        ...makeExecAuth({ MOCA_RELAY_EXEC_TOKEN: HARNESS }),
        log: (l) => lines.push(l),
      },
    });
    closers.push(r.shutdown);
    const res = await exec(`127.0.0.1:${r.execPort}`, { token: token() }).done;
    expect(res.code).toBe(status.UNAUTHENTICATED);
    expect(lines).toEqual([]);
  });
});
