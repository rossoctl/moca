import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSigner } from '@moca/control-plane';
import { armDeadline, makeExecAuth } from '../src/main.js';
import {
  DEFAULT_SANDBOX_MAX_INFLIGHT,
  makeSandboxTokenVerifier,
  sandboxMaxInflight,
  workerReqId,
} from '../src/sandbox-auth.js';

const ISS = 'sbx-control-plane';

function keypair() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  return { signer, keyset: `${signer.kid}:${signer.publicKeyBase64}` };
}
const K = keypair();

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a throw');
}

describe('workerReqId (SBX0 §3.6)', () => {
  it('is the first 53 bits of SHA-256(sbx, 0x00, reqId as 8 big-endian bytes)', () => {
    const be = Buffer.alloc(8);
    be.writeBigUInt64BE(4242n);
    const digest = createHash('sha256')
      .update(Buffer.concat([Buffer.from('sbx-aaaa', 'utf8'), Buffer.from([0]), be]))
      .digest();
    const want = Number(digest.readBigUInt64BE(0) >> 11n);
    expect(workerReqId('sbx-aaaa', 4242)).toBe(want);
  });

  it('is deterministic, so a retry of the same req_id reaches the worker dedup', () => {
    expect(workerReqId('sbx-aaaa', 7)).toBe(workerReqId('sbx-aaaa', 7));
  });

  it('differs for two sandboxes sending the same req_id', () => {
    expect(workerReqId('sbx-aaaa', 7)).not.toBe(workerReqId('sbx-bbbb', 7));
    // The 0x00 separator: ('sbx-a', …) and ('sbx-', …) cannot meet by shifting a byte across.
    expect(workerReqId('sbx-a', 7)).not.toBe(workerReqId('sbx-', 7));
  });

  it('stays in 1 <= id < 2^53 across the whole uint64-as-number range', () => {
    for (const reqId of [0, 1, 2, 255, 2 ** 32, 2 ** 52, Number.MAX_SAFE_INTEGER]) {
      for (const sbx of ['sbx-aaaa', 'sbx-bbbb', 'x']) {
        const id = workerReqId(sbx, reqId);
        expect(Number.isSafeInteger(id)).toBe(true);
        expect(id).toBeGreaterThanOrEqual(1);
        expect(id).toBeLessThan(2 ** 53);
      }
    }
  });

  it('refuses a req_id that is not a uint64 the wire could carry as a number', () => {
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => workerReqId('sbx-aaaa', bad)).toThrow(RangeError);
    }
  });
});

describe('the relay boot rule (SBX0 §3.3)', () => {
  it('refuses to boot with neither credential, naming both', () => {
    expect(() => makeExecAuth({})).toThrow(/MOCA_RELAY_EXEC_TOKEN or SH_SANDBOX_TOKEN_PUBLIC_KEYS/);
    // An empty harness token and a blank keyset are no credential either.
    expect(() =>
      makeExecAuth({ MOCA_RELAY_EXEC_TOKEN: '', SH_SANDBOX_TOKEN_PUBLIC_KEYS: ' ' }),
    ).toThrow(/MOCA_RELAY_EXEC_TOKEN or SH_SANDBOX_TOKEN_PUBLIC_KEYS/);
  });

  it('boots with a keyset and no harness exec token', () => {
    const a = makeExecAuth({
      SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset,
      SH_SANDBOX_TOKEN_ISSUER: ISS,
    });
    expect(a.validateExecToken('anything')).toBe(false);
    expect(a.validateExecToken(undefined)).toBe(false);
    expect(a.verifySandboxToken).toBeTypeOf('function');
    expect(a.sandboxMaxInflight).toBe(DEFAULT_SANDBOX_MAX_INFLIGHT);
  });

  it('boots harness-only exactly as before: no sandbox verifier', () => {
    const a = makeExecAuth({ MOCA_RELAY_EXEC_TOKEN: 'harness-token' }); // notsecret
    expect(a.validateExecToken('harness-token')).toBe(true); // notsecret
    expect(a.verifySandboxToken).toBeUndefined();
  });

  it.each([
    ['not a kid:key pair', 'nope-value-xyz'],
    ['not a base64 SPKI', 'kidvalue1234:QUFBQQ=='],
    ['a kid that does not match its key', `wrongkid9876:${K.signer.publicKeyBase64}`],
    ['a good entry then a bad one', `${K.keyset},nope-value-xyz`],
  ])(
    'refuses a malformed keyset (%s), naming the variable and never echoing the value',
    (_name, raw) => {
      const err = thrown(() =>
        makeSandboxTokenVerifier({
          SH_SANDBOX_TOKEN_PUBLIC_KEYS: raw,
          SH_SANDBOX_TOKEN_ISSUER: ISS,
        }),
      );
      expect(err.message).toMatch(/^SH_SANDBOX_TOKEN_PUBLIC_KEYS /);
      // Not the session keyset's name: the operator must fix the variable this relay reads.
      expect(err.message).not.toMatch(/SH_SESSION_TOKEN_PUBLIC_KEYS/);
      for (const part of raw.split(/[,:]/)) expect(err.message).not.toContain(part);
      // And through the boot rule too.
      expect(() =>
        makeExecAuth({ SH_SANDBOX_TOKEN_PUBLIC_KEYS: raw, SH_SANDBOX_TOKEN_ISSUER: ISS }),
      ).toThrow(/^SH_SANDBOX_TOKEN_PUBLIC_KEYS /);
    },
  );

  it('names the failing entry by position', () => {
    const err = thrown(() =>
      makeSandboxTokenVerifier({
        SH_SANDBOX_TOKEN_PUBLIC_KEYS: `${K.keyset},nope-value-xyz`,
        SH_SANDBOX_TOKEN_ISSUER: ISS,
      }),
    );
    expect(err.message).toMatch(/entry 2/);
  });

  it('refuses a keyset without SH_SANDBOX_TOKEN_ISSUER', () => {
    for (const issuer of [undefined, '', '  ']) {
      expect(() =>
        makeSandboxTokenVerifier({
          SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset,
          SH_SANDBOX_TOKEN_ISSUER: issuer,
        }),
      ).toThrow(/SH_SANDBOX_TOKEN_ISSUER is required/);
    }
    expect(() => makeExecAuth({ SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset })).toThrow(
      /SH_SANDBOX_TOKEN_ISSUER is required/,
    );
  });

  it('keeps the existing clash checks when a harness token is set beside sandbox keys', () => {
    const shared = 'shared-value-1234'; // notsecret
    const err = thrown(() =>
      makeExecAuth({
        MOCA_RELAY_EXEC_TOKEN: shared,
        SH_RELAY_TOKEN_sbx1: shared,
        SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset,
        SH_SANDBOX_TOKEN_ISSUER: ISS,
      }),
    );
    expect(err.message).toMatch(/SH_RELAY_TOKEN_sbx1/);
    expect(err.message).not.toContain(shared);
  });

  it('keeps the harness exec token working beside sandbox tokens', () => {
    const a = makeExecAuth({
      MOCA_RELAY_EXEC_TOKEN: 'harness-token-harness-token', // notsecret
      SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset,
      SH_SANDBOX_TOKEN_ISSUER: ISS,
    });
    expect(a.validateExecToken('harness-token-harness-token')).toBe(true); // notsecret
    expect(a.verifySandboxToken).toBeTypeOf('function');
  });

  it('reads SH_SANDBOX_MAX_INFLIGHT as a positive integer, default 2', () => {
    expect(DEFAULT_SANDBOX_MAX_INFLIGHT).toBe(2);
    expect(sandboxMaxInflight({})).toBe(2);
    expect(sandboxMaxInflight({ SH_SANDBOX_MAX_INFLIGHT: '5' })).toBe(5);
    expect(sandboxMaxInflight({ SH_SANDBOX_MAX_INFLIGHT: ' 1 ' })).toBe(1);
    // Empty is unset, as for the control plane's SH_SANDBOX_TOKEN_TTL_SECONDS (sandbox-config.ts).
    expect(sandboxMaxInflight({ SH_SANDBOX_MAX_INFLIGHT: '' })).toBe(2);
  });

  it('checks SH_SANDBOX_MAX_INFLIGHT on a harness-only relay too: a typo fails loud, not later', () => {
    const harness = 'harness-token'; // notsecret
    expect(() =>
      makeExecAuth({ MOCA_RELAY_EXEC_TOKEN: harness, SH_SANDBOX_MAX_INFLIGHT: 'abc' }),
    ).toThrow(/^SH_SANDBOX_MAX_INFLIGHT must be a positive integer/);
    // And a harness-only relay carries no cap: harness Execs are never capped.
    expect(makeExecAuth({ MOCA_RELAY_EXEC_TOKEN: harness }).sandboxMaxInflight).toBeUndefined();
  });

  it.each(['0', '-1', 'abc', '00', '1.5', '2x', '1e3', '99999999999999999999'])(
    'refuses to boot with SH_SANDBOX_MAX_INFLIGHT=%j, naming the variable',
    (v) => {
      expect(() =>
        makeExecAuth({
          SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset,
          SH_SANDBOX_TOKEN_ISSUER: ISS,
          SH_SANDBOX_MAX_INFLIGHT: v,
        }),
      ).toThrow(/^SH_SANDBOX_MAX_INFLIGHT must be a positive integer/);
    },
  );
});

describe('armDeadline', () => {
  afterEach(() => vi.useRealTimers());

  it('fires at the deadline, and not after it is cancelled', () => {
    vi.useFakeTimers();
    let fired = 0;
    armDeadline(Date.now() + 1_000, () => fired++);
    vi.advanceTimersByTime(999);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    const cancel = armDeadline(Date.now() + 1_000, () => fired++);
    cancel();
    vi.advanceTimersByTime(5_000);
    expect(fired).toBe(1);
  });

  it("does not fire early for a deadline past setTimeout's 2^31-1 ms ceiling", () => {
    // Node clamps a longer delay to 1 ms, which would cancel a long-lived token's Exec at once.
    vi.useFakeTimers();
    let fired = 0;
    const days40 = 40 * 86_400_000;
    const cancel = armDeadline(Date.now() + days40, () => fired++);
    vi.advanceTimersByTime(30 * 86_400_000);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(10 * 86_400_000);
    expect(fired).toBe(1);
    cancel();
  });

  it('fires at once for a deadline already past', () => {
    vi.useFakeTimers();
    let fired = 0;
    armDeadline(Date.now() - 5_000, () => fired++);
    vi.advanceTimersByTime(0);
    expect(fired).toBe(1);
  });
});

/**
 * The registered Exec handler, driven with fake calls (the main-wiring.test.ts pattern). Over a real
 * transport grpc-js drops a write after the status has gone out, so a relay that kept writing after
 * expiry would look the same there; a fake call records every write, so here it does not.
 */
describe('the sandbox Exec handler after its token expires', () => {
  const records = { put: async () => {}, remove: async () => {}, list: async () => [] };

  function handler(server: unknown, path: string): (call: unknown) => unknown {
    return (server as { handlers: Map<string, { func: (call: unknown) => unknown }> }).handlers.get(
      path,
    )!.func;
  }

  it('writes nothing, and ends the call only once, after the expiry fired', async () => {
    const { EventEmitter } = await import('node:events');
    const { buildServer } = await import('../src/main.js');
    const { status } = await import('@grpc/grpc-js');
    const claims = {
      iss: ISS,
      aud: 'moca-sandbox',
      sub: 'github:1',
      tenant: 'github:1',
      sbx: 'sbx-aaaa',
      wrk: 'sbx_default',
      wsk: 'sbx-aaaa',
      scope: ['exec'],
      iat: 0,
      exp: 0,
      jti: 'j',
    };
    const pending: Array<() => void> = [];
    const { server } = buildServer({
      records,
      validateToken: () => true,
      validateExecToken: () => false,
      verifySandboxToken: () => ({ claims }),
      log: () => {},
      timers: {
        setTimeout: (fn) => (pending.push(fn), pending.length),
        clearTimeout: () => {},
      },
    });
    const worker = Object.assign(new EventEmitter(), {
      metadata: { get: () => [] },
      written: [] as Array<{ exec?: { reqId: number }; abort?: { reqId: number } }>,
      write(f: never) {
        this.written.push(f);
      },
      end() {},
    });
    handler(server, '/sandbox.v1.SandboxWorker/Attach')(worker);
    worker.emit('data', {
      hello: { sandboxId: 'sbx_default', labels: {}, capabilities: [], capacityMax: 1 },
    });
    const errors: Array<{ code: number; details: string }> = [];
    const call = Object.assign(new EventEmitter(), {
      request: {
        sandboxId: 'sbx_default',
        exec: { reqId: 5, command: 'true', workspaceKey: 'sbx-aaaa' },
      },
      metadata: { get: () => ['Bearer x'] },
      written: [] as unknown[],
      write(ev: unknown) {
        this.written.push(ev);
      },
      end() {},
    });
    call.on('error', (e: { code: number; details: string }) => errors.push(e));
    const done = handler(server, '/sandbox.v1.SandboxExec/Exec')(call) as Promise<void>;
    const wid = workerReqId('sbx-aaaa', 5);
    expect(worker.written.map((f) => f.exec?.reqId)).toEqual([wid]);
    expect(pending).toHaveLength(1);
    pending[0]!(); // the token expires
    expect(errors).toEqual([
      expect.objectContaining({
        code: status.DEADLINE_EXCEEDED,
        details: 'sandbox token expired during the Exec',
      }),
    ]);
    expect(worker.written.map((f) => f.abort?.reqId).filter(Boolean)).toEqual([wid]);
    // The worker acknowledges the Abort; the frame is drained, never written, never re-classified.
    worker.emit('data', { chunk: { reqId: wid, data: Buffer.from('late'), stream: 1 } });
    worker.emit('data', { error: { reqId: wid, message: 'aborted' } });
    await done;
    expect(call.written).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
