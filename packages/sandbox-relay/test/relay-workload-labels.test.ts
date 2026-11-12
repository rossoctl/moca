import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { status } from '@grpc/grpc-js';
import { makeSigner, mintAttachToken } from '@moca/control-plane';
import type { RecordStore, SandboxRecord } from '@moca/harness';
import { createRelay, type RelayDeps } from '../src/relay.js';
import { makeAttachVerifier, makeDefaultValidateToken } from '../src/main.js';

/**
 * Trusted workload labels (workload sandboxes spec §3.2-3.3, #476 phase 2 PR 1). Tokens are real:
 * minted with the control plane's signer and verified through makeAttachVerifier, the verifier
 * main.ts wires from MOCA_ATTACH_PUBLIC_KEYS.
 */

// Generated per run, never embedded (see control-plane's token.test.ts).
function attachSigner() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  return { signer, keysEnv: `${signer.kid}:${signer.publicKeyBase64}` };
}

const WL = `w-${'a'.repeat(32)}`;
const OTHER_WL = `w-${'f'.repeat(32)}`;
const OWN = 'b'.repeat(32);
const SHARED = 'shared-token';
const now = () => Math.floor(Date.now() / 1000);
/** A valid attach token for WL with two sandboxes, a 10-minute life; `over` varies one input. */
const mint = (
  signer: ReturnType<typeof makeSigner>,
  over: Partial<Parameters<typeof mintAttachToken>[1]> = {},
) =>
  mintAttachToken(signer, {
    wl: WL,
    own: OWN,
    gen: 'g1',
    tr: 'container',
    n: 2,
    now: now(),
    ttlSeconds: 600,
    ...over,
  });
/** Every claim of a valid attach token, for hand-signed variants. */
const claims = () => ({
  iss: 'moca-provisioner',
  aud: 'moca-relay-attach',
  wl: WL,
  own: OWN,
  gen: 'g1',
  tr: 'container',
  n: 2,
  iat: now(),
  exp: now() + 600,
  jti: 'j',
});

function fakeRecords() {
  const map = new Map<string, SandboxRecord>();
  const store: RecordStore = {
    put: vi.fn(async (r) => void map.set(r.sandboxId, r)),
    remove: vi.fn(async (id) => void map.delete(id)),
    list: async () => [...map.values()],
  };
  return { store, map };
}

function fakeAttach(token?: string) {
  const s = new EventEmitter() as EventEmitter & {
    metadata: { get: (k: string) => string[] };
    write: (f: unknown) => void;
    end: () => void;
    written: any[];
    ended: boolean;
    emitData: (f: unknown) => void;
  };
  s.metadata = { get: (k) => (k === 'authorization' && token ? [`Bearer ${token}`] : []) };
  s.written = [];
  s.ended = false;
  s.write = (f) => s.written.push(f);
  s.end = () => {
    s.ended = true;
    s.emit('end');
  };
  s.emitData = (f) => s.emit('data', f);
  return s;
}

const hello = (sandboxId: string, labels: Record<string, string> = {}) => ({
  hello: {
    sandboxId,
    labels,
    capabilities: ['python3'],
    image: 'img',
    arch: 'amd64',
    capacityMax: 4,
    trust: 'trusted',
  },
});

const SPOOFED = {
  team: 't1',
  'moca.dev/workload': OTHER_WL,
  'moca.dev/owner': 'c'.repeat(32),
  'moca.dev/tier': 'microvm',
};

/** A relay as main.ts builds it: the shared token, and attach keys when `keysEnv` is given. */
function relayWith(keysEnv?: string) {
  const { store, map } = fakeRecords();
  const env = { SH_RELAY_TOKEN: SHARED, ...(keysEnv ? { MOCA_ATTACH_PUBLIC_KEYS: keysEnv } : {}) };
  const verifyAttach = makeAttachVerifier(env);
  const deps: RelayDeps = {
    records: store,
    validateToken: makeDefaultValidateToken(env),
    ...(verifyAttach ? { verifyAttach } : {}),
  };
  return { relay: createRelay(deps), map };
}

/** Attach `id` with `token`; resolves to the record written, or undefined when refused. */
async function attach(
  r: ReturnType<typeof relayWith>,
  id: string,
  token: string | undefined,
  labels?: Record<string, string>,
) {
  const s = fakeAttach(token);
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  r.relay.onAttach(s as never);
  s.emitData(hello(id, labels));
  await new Promise((res) => setTimeout(res, 5));
  err.mockRestore();
  return { stream: s, rec: r.map.get(id) };
}

const exec = (reqId = 1) => ({
  reqId,
  command: 'true',
  stdin: new Uint8Array(),
  timeoutS: 0,
  streaming: true,
  workspaceKey: '',
});

async function drive(
  r: ReturnType<typeof relayWith>,
  stream: ReturnType<typeof fakeAttach>,
  id: string,
  workload: string | undefined,
): Promise<{ code?: number; ok?: boolean }> {
  const gen = r.relay.routeExec(id, exec(), workload === undefined ? undefined : { workload });
  // Settled into a value at once, so a refusal is never an unhandled rejection while we wait.
  const pump = (async () => {
    for await (const _ of gen) void _;
  })().then(
    () => ({ ok: true }),
    (e: unknown) => ({ code: (e as { code?: number }).code }),
  );
  // Answer the exec if it reached the worker.
  await new Promise((res) => setTimeout(res, 5));
  const sent = stream.written.find((f) => f.exec && !f.answered);
  if (sent) {
    sent.answered = true;
    stream.emitData({ end: { reqId: sent.exec.reqId, exitCode: 0 } });
  }
  return pump;
}

describe('relay trusted workload labels: attach keys configured', () => {
  it('a valid attach token stamps workload, owner and tier, whatever Hello sends', async () => {
    const { signer, keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const token = mint(signer);
    const { rec } = await attach(r, `${WL}-0`, token, SPOOFED);
    expect(rec?.labels).toEqual({
      team: 't1',
      'moca.dev/workload': WL,
      'moca.dev/owner': OWN,
      'moca.dev/tier': 'container',
    });
    // Capabilities pass through as today.
    expect(rec?.capabilities).toEqual(['python3']);
  });

  it('refuses a forged token (signed by a key the relay does not hold)', async () => {
    const { keysEnv } = attachSigner();
    const forger = attachSigner().signer;
    const r = relayWith(keysEnv);
    const token = mint(forger);
    const { rec, stream } = await attach(r, `${WL}-0`, token);
    expect(rec).toBeUndefined();
    expect(stream.ended).toBe(true);
    expect(r.relay.parked()).toEqual([]);
  });

  it('refuses an expired token', async () => {
    const { signer, keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const token = mint(signer, { now: now() - 3600, ttlSeconds: 60 });
    expect((await attach(r, `${WL}-0`, token)).rec).toBeUndefined();
  });

  it('refuses a wrong typ (a session token from the same key) and a wrong audience', async () => {
    const { signer, keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const session = signer.mint({
      sub: 'github:1',
      tenant: 'github:1',
      roles: [],
      scope: ['turn:write'],
      ttlSeconds: 300,
    });
    expect((await attach(r, `${WL}-0`, session)).rec).toBeUndefined();
    const wrongAud = signer.signJws('moca-attach+jwt', { ...claims(), aud: 'harness' });
    expect((await attach(r, `${WL}-1`, wrongAud)).rec).toBeUndefined();
    const wrongIss = signer.signJws('moca-attach+jwt', { ...claims(), iss: 'sh-control-plane' });
    expect((await attach(r, `${WL}-1`, wrongIss)).rec).toBeUndefined();
    const { exp: _exp, ...noExpClaims } = claims();
    const noExp = signer.signJws('moca-attach+jwt', noExpClaims);
    expect((await attach(r, `${WL}-1`, noExp)).rec).toBeUndefined();
    // The control: the same hand-signed claims, unaltered, are accepted.
    expect(
      (await attach(r, `${WL}-1`, signer.signJws('moca-attach+jwt', claims()))).rec,
    ).toBeDefined();
  });

  it('refuses an ordinal at or above n, and a non-canonical ordinal', async () => {
    const { signer, keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const token = mint(signer, { n: 2 });
    for (const id of [`${WL}-2`, `${WL}-3`, `${WL}-10`, `${WL}-01`, `${WL}-00`]) {
      expect((await attach(r, id, token)).rec, id).toBeUndefined();
    }
    expect((await attach(r, `${WL}-1`, token)).rec).toBeDefined();
    expect((await attach(r, `${WL}-0`, token)).rec).toBeDefined();
    expect(r.relay.parked().sort()).toEqual([`${WL}-0`, `${WL}-1`]);
  });

  it("closes an attach stream when its token's exp passes, removing its record", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { signer, keysEnv } = attachSigner();
      const r = relayWith(keysEnv);
      const s = fakeAttach(mint(signer, { ttlSeconds: 60 }));
      r.relay.onAttach(s as never);
      s.emitData(hello(`${WL}-0`));
      await vi.advanceTimersByTimeAsync(0);
      expect(r.map.has(`${WL}-0`)).toBe(true);
      // exp + the 30 s clock leeway: still open just before it.
      await vi.advanceTimersByTimeAsync(89_000);
      expect(s.ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(s.ended).toBe(true);
      expect(r.relay.parked()).toEqual([]);
      expect(r.map.has(`${WL}-0`)).toBe(false);
      err.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the expiry timer when the stream disconnects first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { signer, keysEnv } = attachSigner();
      const r = relayWith(keysEnv);
      const s = fakeAttach(mint(signer, { ttlSeconds: 60 }));
      r.relay.onAttach(s as never);
      s.emitData(hello(`${WL}-0`));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      s.end();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a sandbox id that is not `<wl>-<n>` of the token's workload", async () => {
    const { signer, keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const token = mint(signer);
    for (const id of [`${OTHER_WL}-0`, `${WL}-x`, `${WL}-`, WL, 'moca-sandbox-0', `${WL}-0-1`]) {
      expect((await attach(r, id, token)).rec, id).toBeUndefined();
    }
    expect(r.relay.parked()).toEqual([]);
  });

  it('drops a template label from a workload sandbox (a binding has no template)', async () => {
    const { signer, keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const { rec } = await attach(r, `${WL}-0`, mint(signer), {
      ...SPOOFED,
      'moca.dev/template': 'py312',
    });
    expect(rec?.labels['moca.dev/template']).toBeUndefined();
    expect(rec?.labels['moca.dev/workload']).toBe(WL);
  });

  it('keeps a template label on a shared-token Hello, as it keeps the tier', async () => {
    const { keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const { rec } = await attach(r, 'moca-sandbox-0', SHARED, {
      'moca.dev/tier': 'microvm',
      'moca.dev/template': 'py312',
    });
    expect(rec?.labels).toEqual({ 'moca.dev/tier': 'microvm', 'moca.dev/template': 'py312' });
  });

  it('strips workload and owner from a shared-token Hello, keeping its other labels', async () => {
    const { keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const { rec } = await attach(r, 'moca-sandbox-0', SHARED, SPOOFED);
    // The tier label is not a trusted label (MI1 §2.3): it stays as sent, as before.
    expect(rec?.labels).toEqual({ team: 't1', 'moca.dev/tier': 'microvm' });
  });

  it("refuses a shared-token Hello that takes a workload sandbox's id", async () => {
    const { keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    expect((await attach(r, `${WL}-0`, SHARED)).rec).toBeUndefined();
  });

  it('keeps the duplicate-id refusal: a second attach token cannot take a live id', async () => {
    const { signer, keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const token = mint(signer);
    const first = await attach(r, `${WL}-0`, token);
    const second = await attach(r, `${WL}-0`, token);
    expect(first.stream.ended).toBe(false);
    expect(second.stream.ended).toBe(true);
    expect(r.relay.parked()).toEqual([`${WL}-0`]);
  });

  it('Exec check: a workload sandbox refuses an Exec without its workload, or naming another', async () => {
    const { signer, keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const token = mint(signer);
    const { stream } = await attach(r, `${WL}-0`, token);
    expect(await drive(r, stream, `${WL}-0`, undefined)).toEqual({
      code: status.PERMISSION_DENIED,
    });
    expect(await drive(r, stream, `${WL}-0`, '')).toEqual({ code: status.PERMISSION_DENIED });
    expect(await drive(r, stream, `${WL}-0`, OTHER_WL)).toEqual({
      code: status.PERMISSION_DENIED,
    });
    // Refused before the worker saw anything.
    expect(stream.written.filter((f) => f.exec)).toHaveLength(0);
    expect(await drive(r, stream, `${WL}-0`, WL)).toEqual({ ok: true });
  });

  it('Exec check: a shared-pool sandbox refuses an Exec that names a workload', async () => {
    const { keysEnv } = attachSigner();
    const r = relayWith(keysEnv);
    const { stream } = await attach(r, 'moca-sandbox-0', SHARED, SPOOFED);
    expect(await drive(r, stream, 'moca-sandbox-0', WL)).toEqual({
      code: status.PERMISSION_DENIED,
    });
    expect(await drive(r, stream, 'moca-sandbox-0', '')).toEqual({ ok: true });
  });
});

describe('relay with NO attach keys: unchanged', () => {
  it('builds no verifier for an unset or blank MOCA_ATTACH_PUBLIC_KEYS', () => {
    expect(makeAttachVerifier({})).toBeUndefined();
    expect(makeAttachVerifier({ MOCA_ATTACH_PUBLIC_KEYS: '  ' })).toBeUndefined();
  });

  it('mirrors every Hello label as sent, workload and owner included', async () => {
    const r = relayWith();
    const { rec } = await attach(r, 'moca-sandbox-0', SHARED, SPOOFED);
    expect(rec?.labels).toEqual(SPOOFED);
  });

  it('admits a workload-shaped id on the shared token, as any id before', async () => {
    const r = relayWith();
    expect((await attach(r, `${WL}-0`, SHARED)).rec).toBeDefined();
  });

  it('refuses an attach token: without keys it is just a wrong shared token', async () => {
    const { signer } = attachSigner();
    const r = relayWith();
    const token = mint(signer);
    expect((await attach(r, `${WL}-0`, token)).rec).toBeUndefined();
  });

  it('ignores the Exec workload field entirely', async () => {
    const r = relayWith();
    const { stream } = await attach(r, 'moca-sandbox-0', SHARED, SPOOFED);
    expect(await drive(r, stream, 'moca-sandbox-0', WL)).toEqual({ ok: true });
    expect(await drive(r, stream, 'moca-sandbox-0', undefined)).toEqual({ ok: true });
  });
});

describe('makeAttachVerifier boot rule', () => {
  it('refuses to build from a malformed keyset, naming the variable but not the value', () => {
    const bad = 'not-a-key-entry-secretish';
    expect(() => makeAttachVerifier({ MOCA_ATTACH_PUBLIC_KEYS: bad })).toThrow(
      /MOCA_ATTACH_PUBLIC_KEYS entry 1/,
    );
    try {
      makeAttachVerifier({ MOCA_ATTACH_PUBLIC_KEYS: bad });
    } catch (e) {
      expect((e as Error).message).not.toContain(bad);
    }
  });

  it('names what is wrong with the entry, by position, without echoing it', () => {
    const { signer, keysEnv } = attachSigner();
    for (const [raw, defect] of [
      [`${keysEnv},nope-value-xyz`, /entry 2 is not '<kid>:<base64 SPKI>'/],
      ['kidvalue1234:QUFBQQ==', /entry 1 is not a base64 Ed25519 SPKI/],
      [`wrongkid9876:${signer.publicKeyBase64}`, /entry 1 has a kid that does not match its key/],
    ] as const) {
      let msg = '';
      try {
        makeAttachVerifier({ MOCA_ATTACH_PUBLIC_KEYS: raw });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/^MOCA_ATTACH_PUBLIC_KEYS /);
      expect(msg).toMatch(defect);
      for (const part of raw.split(/[,:]/)) expect(msg).not.toContain(part);
    }
  });

  it('accepts a list, so a key can be rotated in before the signer switches', async () => {
    const a = attachSigner();
    const b = attachSigner();
    const r = relayWith(`${a.keysEnv},${b.keysEnv}`);
    for (const [i, s] of [a.signer, b.signer].entries()) {
      const token = mint(s);
      expect((await attach(r, `${WL}-${i}`, token)).rec, `key ${i}`).toBeDefined();
    }
  });
});
