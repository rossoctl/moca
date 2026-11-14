import { Metadata, Server, credentials, status, type ServerUnaryCall } from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LeaseOp,
  LeaseStatus,
  SandboxExecClient,
  SandboxMode,
  type LeaseControlResponse,
} from '@moca/k8s-sandbox';
import { LEASE_CONTROL_MAX_INFLIGHT, makeAudit, makeSandboxCaller } from '../src/sandbox-caller.js';
import { makeSandboxTokenVerifier, makeSetModeTokenVerifier } from '../src/sandbox-auth.js';
import type { Relay } from '../src/relay.js';
import {
  HARNESS,
  ISS,
  K,
  REQ_ID_KEY,
  closeAll,
  now,
  reasons,
  relay,
  setModeToken,
  sleep,
  token,
  tokenB,
  worker,
  type LeaseReply,
} from './helpers/sandbox-relay.js';

// Lease-mode spec §8.2: LeaseControl and LeaseKeepalive act on a sandbox's lease, not on one Exec.
// Only a sandbox-token caller may make them, only on its own worker and workspace; set_mode also
// needs a set-mode token for that same sandbox, and the frame's mode and epoch come from it. Every
// LeaseControl ends: on the worker's answer, at the relay's per-op timeout (an old worker ignores
// the frame), or when the worker goes away.

afterEach(closeAll);

/** Short per-op timeouts (ruling R4), so a silent worker ends a call in the test's time. */
const SHORT = { leaseTimeoutsMs: { status: 300, mutate: 300 } };

const ACTIVE = LeaseStatus.fromPartial({
  mode: SandboxMode.SANDBOX_MODE_LEASE,
  epochKnown: true,
  state: 'active',
  ageMs: 1234,
  idleTimeoutS: 300,
});
const answers: LeaseReply = () => ({ status: ACTIVE });

interface CallResult {
  code: number;
  details: string;
  res?: LeaseControlResponse;
}

type LeaseControlOpts = { sandboxId?: string; setModeToken?: string };

/** One LeaseControl call that the test may cancel. */
function leaseControlCall(
  addr: string,
  t: string | undefined,
  op: LeaseOp,
  opts: LeaseControlOpts = {},
): { done: Promise<CallResult>; cancel: () => void } {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  if (t !== undefined) md.set('authorization', `Bearer ${t}`);
  let cancel = () => {};
  const done = new Promise<CallResult>((resolve) => {
    const call = client.leaseControl(
      {
        sandboxId: opts.sandboxId ?? 'sbx_default',
        op,
        setModeToken: opts.setModeToken ?? '',
      },
      md,
      (err, res) =>
        resolve(
          err ? { code: err.code, details: err.details } : { code: status.OK, details: '', res },
        ),
    );
    cancel = () => call.cancel();
  }).finally(() => client.close());
  return { done, cancel };
}

const leaseControl = (
  addr: string,
  t: string | undefined,
  op: LeaseOp,
  opts: LeaseControlOpts = {},
): Promise<CallResult> => leaseControlCall(addr, t, op, opts).done;

function leaseKeepalive(
  addr: string,
  t: string | undefined,
  sandboxId = 'sbx_default',
): Promise<CallResult> {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  if (t !== undefined) md.set('authorization', `Bearer ${t}`);
  return new Promise<CallResult>((resolve) =>
    client.leaseKeepalive({ sandboxId }, md, (err) =>
      resolve(err ? { code: err.code, details: err.details } : { code: status.OK, details: '' }),
    ),
  ).finally(() => client.close());
}

const leaseLines = (lines: string[]) =>
  reasons(lines).filter((l) => l.audit === 'sandbox_lease_control') as unknown as Array<
    Record<string, unknown>
  >;

describe('LeaseControl (lease-mode §8.2)', () => {
  it('status round-trips: the worker gets the token workspace, the caller its status', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, answers);
    const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS);
    expect(got.code).toBe(status.OK);
    expect(got.res?.status).toEqual(ACTIVE);
    expect(w.controls).toHaveLength(1);
    expect(w.controls[0]).toMatchObject({
      workspaceKey: 'sbx-aaaa',
      op: LeaseOp.LEASE_OP_STATUS,
      mode: SandboxMode.SANDBOX_MODE_UNSPECIFIED,
      modeEpoch: 0,
    });
    expect(w.controls[0]!.ctlId).toBeGreaterThan(0);
    const [line] = leaseLines(r.lines);
    expect(line).toMatchObject({
      audit: 'sandbox_lease_control',
      sub: 'github:1',
      sbx: 'sbx-aaaa',
      wrk: 'sbx_default',
      op: 'status',
      outcome: 'ok',
    });
    expect(line).not.toHaveProperty('mode');
  });

  it('each call gets its own ctl_id, and each answer reaches its own caller', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const a = leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS);
    const b = leaseControl(r.exec, token(), LeaseOp.LEASE_OP_RESET);
    await sleep(150);
    expect(w.controls).toHaveLength(2);
    expect(w.controls[0]!.ctlId).not.toBe(w.controls[1]!.ctlId);
    // Answered out of order: the reset first.
    const byOp = (op: LeaseOp) => w.controls.find((c) => c.op === op)!.ctlId;
    w.answerControl(byOp(LeaseOp.LEASE_OP_RESET), {
      status: LeaseStatus.fromPartial({ state: 'none' }),
    });
    w.answerControl(byOp(LeaseOp.LEASE_OP_STATUS), { status: ACTIVE });
    expect((await a).res?.status?.state).toBe('active');
    expect((await b).res?.status?.state).toBe('none');
  });

  it('set_mode with a valid token: the worker gets the token mode and epoch', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, answers);
    const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_SET_MODE, {
      setModeToken: setModeToken({ mode: 'lease+processes', modeEpoch: 7 }),
    });
    expect(got.code).toBe(status.OK);
    expect(w.controls).toEqual([
      expect.objectContaining({
        workspaceKey: 'sbx-aaaa',
        op: LeaseOp.LEASE_OP_SET_MODE,
        mode: SandboxMode.SANDBOX_MODE_LEASE_PROCESSES,
        modeEpoch: 7,
      }),
    ]);
    expect(leaseLines(r.lines)).toEqual([
      expect.objectContaining({
        op: 'set_mode',
        outcome: 'ok',
        mode: 'lease+processes',
        modeEpoch: 7,
      }),
    ]);
  });

  it("refuses another sandbox's set-mode token, and sends the worker nothing", async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, answers);
    for (const over of [{ sbx: 'sbx-bbbb' }, { wrk: 'sbx_other' }, { wsk: 'sbx-bbbb' }]) {
      const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_SET_MODE, {
        setModeToken: setModeToken(over),
      });
      expect(got.code).toBe(status.PERMISSION_DENIED);
    }
    expect(w.controls).toEqual([]);
    expect(leaseLines(r.lines).map((l) => [l.op, l.outcome])).toEqual([
      ['set_mode', 'refused'],
      ['set_mode', 'refused'],
      ['set_mode', 'refused'],
    ]);
  });

  it('every set-mode token refusal tells the client the same thing', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, answers);
    const got = await Promise.all(
      [
        setModeToken({ now: now() - 1000 }), // expired
        setModeToken({ sbx: 'sbx-bbbb' }), // verified, another sandbox
        token({ mode: 'lease' }), // a sandbox token
        '', // none
      ].map((t) => leaseControl(r.exec, token(), LeaseOp.LEASE_OP_SET_MODE, { setModeToken: t })),
    );
    expect(got.map((g) => g.code)).toEqual(Array(4).fill(status.PERMISSION_DENIED));
    expect(new Set(got.map((g) => g.details)).size).toBe(1);
    // The reasons differ, in the audit line alone.
    expect(new Set(leaseLines(r.lines).map((l) => l.reason)).size).toBe(4);
    expect(w.controls).toEqual([]);
  });

  it('refuses an expired set-mode token', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, answers);
    // Minted 1000 s ago with a 300 s TTL: past exp plus the 30 s leeway.
    const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_SET_MODE, {
      setModeToken: setModeToken({ now: now() - 1000 }),
    });
    expect(got.code).toBe(status.PERMISSION_DENIED);
    expect(w.controls).toEqual([]);
    expect(leaseLines(r.lines)[0]).toMatchObject({ outcome: 'refused', reason: 'token expired' });
  });

  it('refuses a sandbox token presented as the set-mode token', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, answers);
    const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_SET_MODE, {
      setModeToken: token({ mode: 'lease', modeEpoch: 9 }),
    });
    expect(got.code).toBe(status.PERMISSION_DENIED);
    expect(w.controls).toEqual([]);
  });

  it('refuses set_mode without a set-mode token', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, answers);
    const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_SET_MODE);
    expect(got.code).toBe(status.PERMISSION_DENIED);
    expect(w.controls).toEqual([]);
  });

  it('refuses a harness caller, an unauthenticated one, and another worker', async () => {
    const r = await relay({ MOCA_RELAY_EXEC_TOKEN: HARNESS });
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, answers);
    expect((await leaseControl(r.exec, HARNESS, LeaseOp.LEASE_OP_STATUS)).code).toBe(
      status.PERMISSION_DENIED,
    );
    expect((await leaseControl(r.exec, 'not-a-token', LeaseOp.LEASE_OP_STATUS)).code).toBe(
      status.UNAUTHENTICATED,
    );
    expect(
      (
        await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS, {
          sandboxId: 'sbx_other',
        })
      ).code,
    ).toBe(status.PERMISSION_DENIED);
    expect(w.controls).toEqual([]);
  });

  it('refuses an unspecified op', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, answers);
    const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_UNSPECIFIED);
    expect(got.code).toBe(status.INVALID_ARGUMENT);
    expect(w.controls).toEqual([]);
  });

  it("maps the worker's error to FAILED_PRECONDITION with its message", async () => {
    const r = await relay();
    await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, () => ({
      error: 'lease_unsupported: the container tier has no leases',
    }));
    const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_RESET);
    expect(got).toMatchObject({
      code: status.FAILED_PRECONDITION,
      details: 'lease_unsupported: the container tier has no leases',
    });
    expect(leaseLines(r.lines)[0]).toMatchObject({
      op: 'reset',
      outcome: 'failed',
      reason: 'lease_unsupported: the container tier has no leases',
    });
  });

  it('the worker never answers: DEADLINE_EXCEEDED at the per-op timeout', async () => {
    const r = await relay({}, SHORT);
    const w = await worker(r.attach, 'sbx_default');
    const t0 = Date.now();
    const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS);
    expect(got.code).toBe(status.DEADLINE_EXCEEDED);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(w.controls).toHaveLength(1);
    expect(leaseLines(r.lines)[0]).toMatchObject({ op: 'status', outcome: 'timeout' });
  });

  it('the worker disconnects mid-call: UNAVAILABLE', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const call = leaseControl(r.exec, token(), LeaseOp.LEASE_OP_RESET);
    await sleep(150);
    expect(w.controls).toHaveLength(1);
    w.close();
    const got = await call;
    expect(got.code).toBe(status.UNAVAILABLE);
    expect(leaseLines(r.lines)[0]).toMatchObject({ op: 'reset', outcome: 'error' });
  });

  it('a late answer, after the timeout, and a duplicate are dropped', async () => {
    const r = await relay({}, SHORT);
    const w = await worker(r.attach, 'sbx_default');
    const timedOut = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS);
    expect(timedOut.code).toBe(status.DEADLINE_EXCEEDED);
    const late = w.controls[0]!.ctlId;
    w.answerControl(late, { status: ACTIVE });
    const next = leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS);
    await sleep(100);
    const id = w.controls[1]!.ctlId;
    w.answerControl(id, { status: ACTIVE });
    w.answerControl(id, { error: 'duplicate' });
    w.answerControl(late, { error: 'late again' });
    expect(await next).toMatchObject({ code: status.OK, res: { status: ACTIVE } });
    // The worker stays attached and serves the next call.
    const after = leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS);
    await sleep(100);
    w.answerControl(w.controls[2]!.ctlId, { status: ACTIVE });
    expect((await after).code).toBe(status.OK);
  });

  it(`at most ${LEASE_CONTROL_MAX_INFLIGHT} in flight per sandbox: the next is RESOURCE_EXHAUSTED`, async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const pending = Array.from({ length: LEASE_CONTROL_MAX_INFLIGHT }, () =>
      leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS),
    );
    await sleep(150);
    expect(w.controls).toHaveLength(LEASE_CONTROL_MAX_INFLIGHT);
    const busy = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS);
    expect(busy.code).toBe(status.RESOURCE_EXHAUSTED);
    expect(w.controls).toHaveLength(LEASE_CONTROL_MAX_INFLIGHT);
    expect(leaseLines(r.lines).at(-1)).toMatchObject({ op: 'status', outcome: 'busy' });
    // Another sandbox on the same worker has its own slots.
    const other = leaseControl(r.exec, tokenB(), LeaseOp.LEASE_OP_STATUS);
    await sleep(100);
    expect(w.controls).toHaveLength(LEASE_CONTROL_MAX_INFLIGHT + 1);
    for (const c of w.controls) w.answerControl(c.ctlId, { status: ACTIVE });
    for (const p of [...pending, other]) expect((await p).code).toBe(status.OK);
    // Answered, the slots are free again.
    const again = leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS);
    await sleep(100);
    w.answerControl(w.controls.at(-1)!.ctlId, { status: ACTIVE });
    expect((await again).code).toBe(status.OK);
  });

  it('saturated, a set_mode is busy whether or not its set-mode token verifies', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const pending = Array.from({ length: LEASE_CONTROL_MAX_INFLIGHT }, () =>
      leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS),
    );
    await sleep(150);
    expect(w.controls).toHaveLength(LEASE_CONTROL_MAX_INFLIGHT);
    // The cap is checked before the set-mode token, so saturation tells a prober nothing about it.
    const bogus = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_SET_MODE, {
      setModeToken: 'not-a-token',
    });
    const valid = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_SET_MODE, {
      setModeToken: setModeToken(),
    });
    expect(bogus).toEqual(valid);
    expect(bogus.code).toBe(status.RESOURCE_EXHAUSTED);
    expect(leaseLines(r.lines).slice(-2)).toEqual([
      expect.objectContaining({ op: 'set_mode', outcome: 'busy' }),
      expect.objectContaining({ op: 'set_mode', outcome: 'busy' }),
    ]);
    expect(w.controls).toHaveLength(LEASE_CONTROL_MAX_INFLIGHT);
    for (const c of w.controls) w.answerControl(c.ctlId, { status: ACTIVE });
    for (const p of pending) expect((await p).code).toBe(status.OK);
  });

  it('a cancelled call frees its slot at once', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const calls = Array.from({ length: LEASE_CONTROL_MAX_INFLIGHT }, () =>
      leaseControlCall(r.exec, token(), LeaseOp.LEASE_OP_RESET),
    );
    await sleep(150);
    expect(w.controls).toHaveLength(LEASE_CONTROL_MAX_INFLIGHT);
    calls[0]!.cancel();
    expect((await calls[0]!.done).code).toBe(status.CANCELLED);
    await sleep(100);
    expect(leaseLines(r.lines).at(-1)).toMatchObject({ op: 'reset', outcome: 'cancelled' });
    // The slot is free before the worker answers: a new call is sent, not refused.
    const fresh = leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS);
    await sleep(100);
    expect(w.controls).toHaveLength(LEASE_CONTROL_MAX_INFLIGHT + 1);
    // The cancelled call's answer is dropped; the others still reach their callers.
    for (const c of w.controls) w.answerControl(c.ctlId, { status: ACTIVE });
    expect((await fresh).code).toBe(status.OK);
    for (const c of calls.slice(1)) expect((await c.done).code).toBe(status.OK);
  });

  it('sandbox_deleted reaches the worker as LEASE_OP_SANDBOX_DELETED and is audited', async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, () => ({
      status: LeaseStatus.fromPartial({ state: 'none' }),
    }));
    // A set-mode token sent with it is ignored: the op takes no mode and no epoch.
    const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_SANDBOX_DELETED, {
      setModeToken: setModeToken({ mode: 'lease+processes', modeEpoch: 7 }),
    });
    expect(got.code).toBe(status.OK);
    expect(got.res?.status?.state).toBe('none');
    expect(w.controls).toEqual([
      expect.objectContaining({
        workspaceKey: 'sbx-aaaa',
        op: LeaseOp.LEASE_OP_SANDBOX_DELETED,
        mode: SandboxMode.SANDBOX_MODE_UNSPECIFIED,
        modeEpoch: 0,
      }),
    ]);
    const [line] = leaseLines(r.lines);
    expect(line).toMatchObject({
      audit: 'sandbox_lease_control',
      sub: 'github:1',
      sbx: 'sbx-aaaa',
      wrk: 'sbx_default',
      op: 'sandbox_deleted',
      outcome: 'ok',
    });
    expect(line).not.toHaveProperty('mode');
  });

  it('no live worker: UNAVAILABLE', async () => {
    const r = await relay();
    const got = await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS);
    expect(got.code).toBe(status.UNAVAILABLE);
  });
});

describe("LeaseControl's cancel listener (review #4559538392)", () => {
  /**
   * Wraps the exec service's leaseControl handler as the relay registers it, to see each server
   * call: its 'cancelled' listeners when the handler is entered, and after the call settled.
   */
  function watchLeaseCalls() {
    const seen: Array<{ call: ServerUnaryCall<unknown, unknown>; before: number }> = [];
    const add = Server.prototype.addService;
    const spy = vi.spyOn(Server.prototype, 'addService').mockImplementation(function (
      this: Server,
      service,
      impl,
    ) {
      const lc = (impl as Record<string, unknown>).leaseControl as
        ((call: ServerUnaryCall<unknown, unknown>, cb: unknown) => void) | undefined;
      const wrapped = lc
        ? {
            ...impl,
            leaseControl: (call: ServerUnaryCall<unknown, unknown>, cb: unknown) => {
              seen.push({ call, before: call.listenerCount('cancelled') });
              lc(call, cb);
            },
          }
        : impl;
      return add.call(this, service, wrapped);
    });
    return { seen, restore: () => spy.mockRestore() };
  }

  it('is removed once the call settles, on an answer and on an error', async () => {
    const w = watchLeaseCalls();
    let r: Awaited<ReturnType<typeof relay>>;
    try {
      r = await relay();
    } finally {
      w.restore();
    }
    // An error: no worker is attached.
    expect((await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS)).code).toBe(
      status.UNAVAILABLE,
    );
    // An answer.
    await worker(r.attach, 'sbx_default', 'auto', 0, undefined, undefined, answers);
    expect((await leaseControl(r.exec, token(), LeaseOp.LEASE_OP_STATUS)).code).toBe(status.OK);
    expect(w.seen).toHaveLength(2);
    for (const { call, before } of w.seen) {
      expect(call.listenerCount('cancelled')).toBe(before);
    }
  });
});

describe('LeaseControl per-op timeouts', () => {
  it('defaults to 15 s for status and LeaseGraceLimit + 60 s for the mutate ops', async () => {
    const timeouts: number[] = [];
    const fake = {
      routeLeaseControl: async (_s: string, _f: unknown, timeoutMs: number) => {
        timeouts.push(timeoutMs);
        return { ctlId: 1, status: ACTIVE, error: '' };
      },
    } as unknown as Relay;
    const env = { SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset, SH_SANDBOX_TOKEN_ISSUER: ISS };
    const caller = makeSandboxCaller(fake, {
      maxInflight: 2,
      leewayS: 30,
      drainGraceS: 60,
      reqIdKey: REQ_ID_KEY,
      audit: makeAudit(undefined, false),
      verifySetMode: makeSetModeTokenVerifier(env),
    });
    const claims = makeSandboxTokenVerifier(env)!(token()).claims!;
    const req = (op: LeaseOp) => ({
      sandboxId: 'sbx_default',
      op,
      setModeToken: op === LeaseOp.LEASE_OP_SET_MODE ? setModeToken() : '',
    });
    for (const op of [
      LeaseOp.LEASE_OP_STATUS,
      LeaseOp.LEASE_OP_RESET,
      LeaseOp.LEASE_OP_SET_MODE,
      LeaseOp.LEASE_OP_SANDBOX_DELETED,
    ])
      await caller.leaseControl(claims, req(op), Date.now());
    expect(timeouts).toEqual([15_000, 31 * 60_000, 31 * 60_000, 31 * 60_000]);
  });
});

describe('LeaseControl refused by the relay route', () => {
  it("the workload check's PERMISSION_DENIED is a refused line, not an error", async () => {
    const fake = {
      routeLeaseControl: async () => {
        throw Object.assign(new Error('lease control not permitted'), {
          code: status.PERMISSION_DENIED,
        });
      },
    } as unknown as Relay;
    const env = { SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset, SH_SANDBOX_TOKEN_ISSUER: ISS };
    const lines: string[] = [];
    const caller = makeSandboxCaller(fake, {
      maxInflight: 2,
      leewayS: 30,
      drainGraceS: 60,
      reqIdKey: REQ_ID_KEY,
      audit: makeAudit((l) => lines.push(l), false),
    });
    const claims = makeSandboxTokenVerifier(env)!(token()).claims!;
    await expect(
      caller.leaseControl(
        claims,
        { sandboxId: 'sbx_default', op: LeaseOp.LEASE_OP_STATUS, setModeToken: '' },
        Date.now(),
      ),
    ).rejects.toMatchObject({ code: status.PERMISSION_DENIED });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ op: 'status', outcome: 'refused' }),
    ]);
  });
});

describe('LeaseKeepalive (lease-mode §4)', () => {
  it("reaches the worker with the token's workspace, unaudited", async () => {
    const r = await relay();
    const w = await worker(r.attach, 'sbx_default');
    const got = await leaseKeepalive(r.exec, token());
    expect(got.code).toBe(status.OK);
    await sleep(100);
    expect(w.keepalives).toEqual([{ workspaceKey: 'sbx-aaaa' }]);
    expect(r.lines).toEqual([]);
  });

  it('with no worker connected: OK, and nothing breaks', async () => {
    const r = await relay();
    expect((await leaseKeepalive(r.exec, token())).code).toBe(status.OK);
    const w = await worker(r.attach, 'sbx_default');
    expect((await leaseKeepalive(r.exec, token())).code).toBe(status.OK);
    await sleep(100);
    expect(w.keepalives).toEqual([{ workspaceKey: 'sbx-aaaa' }]);
  });

  it('ten keepalives in 100 ms reach the worker once; one after 1 s reaches it again', async () => {
    let clock = 1_000_000;
    const r = await relay({}, { now: () => clock });
    const w = await worker(r.attach, 'sbx_default');
    for (let i = 0; i < 10; i++) {
      // Every call is answered OK, the coalesced ones too.
      expect((await leaseKeepalive(r.exec, token())).code).toBe(status.OK);
      clock += 10;
    }
    // Per workspace: another workspace's keepalive inside the same window is its own.
    expect((await leaseKeepalive(r.exec, tokenB())).code).toBe(status.OK);
    await sleep(100);
    expect(w.keepalives).toEqual([{ workspaceKey: 'sbx-aaaa' }, { workspaceKey: 'sbx-bbbb' }]);
    clock = 1_000_000 + 1_000;
    expect((await leaseKeepalive(r.exec, token())).code).toBe(status.OK);
    await sleep(100);
    expect(w.keepalives).toEqual([
      { workspaceKey: 'sbx-aaaa' },
      { workspaceKey: 'sbx-bbbb' },
      { workspaceKey: 'sbx-aaaa' },
    ]);
    expect(r.lines).toEqual([]);
  });

  it('refuses a harness caller, an unauthenticated one, and another worker', async () => {
    const r = await relay({ MOCA_RELAY_EXEC_TOKEN: HARNESS });
    const w = await worker(r.attach, 'sbx_default');
    expect((await leaseKeepalive(r.exec, HARNESS)).code).toBe(status.PERMISSION_DENIED);
    expect((await leaseKeepalive(r.exec, undefined)).code).toBe(status.UNAUTHENTICATED);
    expect((await leaseKeepalive(r.exec, token(), 'sbx_other')).code).toBe(
      status.PERMISSION_DENIED,
    );
    await sleep(100);
    expect(w.keepalives).toEqual([]);
  });
});
