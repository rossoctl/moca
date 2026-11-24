import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseOutcome } from '@moca/k8s-sandbox';
import {
  CONTROL_RELEASE_MAX_INFLIGHT,
  MAX_CONTROL_BODY_BYTES,
  RELEASE_PATH,
  buildControlServer,
  listenControl,
  makeReleaseTokenValidator,
} from '../src/control-listener.js';
import { createRelay } from '../src/relay.js';
import { makeDefaultValidateToken, makeExecAuth, startRelay } from '../src/main.js';
import { RELEASE_CAPABILITY } from '../src/relay.js';
import {
  HARNESS,
  ISS,
  K,
  REQ_ID_KEY,
  closeAll,
  closers,
  records,
  token,
  worker,
  type ReleaseReply,
} from './helpers/sandbox-relay.js';

// #338: the relay's control listener. Off unless MOCA_RELAY_CONTROL_ADDR is set; one route,
// POST /v1/release {worker, workspaceKey}, authorized by the release-only bearer alone; it goes
// through the relay's release routing and answers the worker's ack (released / kept_busy /
// unknown_key), `release_unsupported` for a worker that predates release, and an error status for
// anything that is not an answer. The bearer must differ from every other bearer, or no boot.

afterEach(closeAll);

const RELEASE = 'r'.repeat(64); // notsecret
const SHORT_MS = 300;

let dirs: string[] = [];
function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'relay-control-'));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

/** A relay with the control listener on loopback (the exec listener split off, as deployed). */
async function controlRelay(opts: { control?: boolean; timeoutMs?: number } = {}) {
  const lines: string[] = [];
  const r = await startRelay({
    port: 0,
    execAddr: '127.0.0.1:0',
    ...(opts.control === false ? {} : { controlAddr: '127.0.0.1:0' }),
    deps: {
      records,
      validateToken: () => true,
      ...makeExecAuth({
        SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset,
        SH_SANDBOX_TOKEN_ISSUER: ISS,
        MOCA_RELAY_EXEC_TOKEN: HARNESS,
      }),
      log: (l: string) => lines.push(l),
      sandboxReqIdKey: REQ_ID_KEY,
      releaseTimeoutMs: opts.timeoutMs ?? SHORT_MS,
      releaseAuth: makeReleaseTokenValidator({ MOCA_RELAY_RELEASE_TOKEN: RELEASE }),
    },
  });
  closers.push(r.shutdown);
  return {
    attach: `127.0.0.1:${r.port}`,
    control: r.controlPort === undefined ? undefined : `http://127.0.0.1:${r.controlPort}`,
    controlPort: r.controlPort,
    lines,
  };
}

async function post(
  base: string,
  body: unknown,
  /** null: no Authorization header at all. */
  bearer: string | null = RELEASE,
  init: { method?: string; path?: string; raw?: string } = {},
) {
  const res = await fetch(`${base}${init.path ?? RELEASE_PATH}`, {
    method: init.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...((init.method ?? 'POST') === 'POST' ? { body: init.raw ?? JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const answers =
  (r: ReturnType<ReleaseReply>): ReleaseReply =>
  () =>
    r;

const releaseWorker = (attach: string, reply?: ReleaseReply, caps = [RELEASE_CAPABILITY]) =>
  worker(attach, 'sbx_default', 'auto', 0, undefined, undefined, undefined, caps, reply);

const controlLines = (lines: string[]) =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.audit === 'sandbox_workspace_release' && l.via === 'control');

const REQ = { worker: 'sbx_default', workspaceKey: 'sbx-0123' };

describe('control listener: off unless MOCA_RELAY_CONTROL_ADDR (#338)', () => {
  it('opens no listener without an address, whatever else is configured', async () => {
    const r = await controlRelay({ control: false });
    expect(r.controlPort).toBeUndefined();
  });

  it('reads no release bearer without an address: a relay with none still boots', async () => {
    // The default deps path, refused before Redis on the missing exec credential -- never on the
    // release bearer, which it does not read with the listener off.
    await expect(startRelay({ port: 0, env: {} })).rejects.toThrow(
      /MOCA_RELAY_EXEC_TOKEN or SH_SANDBOX_TOKEN_PUBLIC_KEYS is required/,
    );
    await expect(
      startRelay({ port: 0, env: { MOCA_RELAY_RELEASE_TOKEN: HARNESS } }),
    ).rejects.toThrow(/MOCA_RELAY_EXEC_TOKEN or SH_SANDBOX_TOKEN_PUBLIC_KEYS is required/);
  });

  it('an address with injected deps but no release bearer refuses to start', async () => {
    await expect(
      startRelay({
        port: 0,
        controlAddr: '127.0.0.1:0',
        deps: { records, validateToken: () => true, validateExecToken: () => false },
      }),
    ).rejects.toThrow(/MOCA_RELAY_CONTROL_ADDR needs the release bearer/);
  });
});

describe('control listener: the release bearer alone (#338)', () => {
  it.each([
    ['no bearer', null],
    ['a wrong bearer of the same length', 'x'.repeat(64)],
    ["the harness's exec token", HARNESS],
    ['a valid sandbox token', token()],
  ])('refuses %s with 401 and sends nothing to the worker', async (_name, bearer) => {
    const r = await controlRelay();
    const w = await releaseWorker(
      r.attach,
      answers({ outcome: ReleaseOutcome.RELEASE_OUTCOME_RELEASED }),
    );
    const got = await post(r.control!, REQ, bearer);
    expect(got).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(w.releases).toHaveLength(0);
    const l = controlLines(r.lines);
    expect(l).toEqual([
      expect.objectContaining({ outcome: 'refused', reason: 'release authentication failed' }),
    ]);
    if (bearer) expect(r.lines.join('\n')).not.toContain(bearer);
  });

  it('serves one route: another path is 404, another method 405, both before the bearer', async () => {
    const r = await controlRelay();
    expect(await post(r.control!, REQ, null, { path: '/v1/exec' })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
    expect(await post(r.control!, REQ, RELEASE, { method: 'GET' })).toEqual({
      status: 405,
      body: { error: 'method_not_allowed' },
    });
  });

  it('answers 413 to a body over the ceiling, before closing: never a reset', async () => {
    const r = await controlRelay();
    const big = JSON.stringify({
      worker: 'sbx_default',
      workspaceKey: 'k'.repeat(MAX_CONTROL_BODY_BYTES * 2),
    });
    expect(await post(r.control!, {}, RELEASE, { raw: big })).toEqual({
      status: 413,
      body: { error: 'invalid_request', message: 'the body is too large' },
    });
  });

  it('throttles refused-bearer lines, counting the refusals each next line stands for', async () => {
    const lines: string[] = [];
    const relay = createRelay({ records, validateToken: () => true });
    const server = buildControlServer(relay, {
      validate: makeReleaseTokenValidator({ MOCA_RELAY_RELEASE_TOKEN: RELEASE }).validate,
      log: (l) => lines.push(l),
      refusedLogIntervalMs: 300,
    });
    const port = await listenControl(server, '127.0.0.1:0');
    closers.push(() => new Promise<void>((res) => server.close(() => res())));
    const base = `http://127.0.0.1:${port}`;
    const bad = 'x'.repeat(64);
    for (let i = 0; i < 5; i++) expect((await post(base, REQ, bad)).status).toBe(401);
    const refused = () =>
      lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.outcome === 'refused');
    expect(refused()).toHaveLength(1);
    expect(refused()[0]).not.toHaveProperty('suppressed');
    await new Promise((res) => setTimeout(res, 350));
    expect((await post(base, REQ, bad)).status).toBe(401);
    expect(refused()).toHaveLength(2);
    expect(refused()[1]).toMatchObject({ suppressed: 4, reason: 'release authentication failed' });
    expect(lines.join('\n')).not.toContain(bad);
  });

  it('refuses a malformed body with 400', async () => {
    const r = await controlRelay();
    expect((await post(r.control!, {}, RELEASE, { raw: 'not json' })).status).toBe(400);
    expect((await post(r.control!, { worker: 'sbx_default' })).body).toMatchObject({
      error: 'invalid_request',
      message: 'workspaceKey must be a non-empty string',
    });
    expect((await post(r.control!, { worker: '', workspaceKey: 'k' })).status).toBe(400);
  });
});

describe("control listener: the worker's answer (#338)", () => {
  it.each([
    [ReleaseOutcome.RELEASE_OUTCOME_RELEASED, 'released'],
    [ReleaseOutcome.RELEASE_OUTCOME_KEPT_BUSY, 'kept_busy'],
    [ReleaseOutcome.RELEASE_OUTCOME_UNKNOWN_KEY, 'unknown_key'],
  ])('answers the ack %s as 200 {outcome: %s}', async (outcome, name) => {
    const r = await controlRelay();
    const w = await releaseWorker(r.attach, answers({ outcome }));
    expect(await post(r.control!, REQ)).toEqual({ status: 200, body: { outcome: name } });
    // The named worker gets the named key: the control plane's, not a token's.
    expect(w.releases).toHaveLength(1);
    expect(w.releases[0]).toMatchObject({ workspaceKey: 'sbx-0123' });
    expect(controlLines(r.lines)).toEqual([
      expect.objectContaining({ via: 'control', wrk: 'sbx_default', outcome: name }),
    ]);
  });

  it('answers release_unsupported, a distinct terminal status, for a worker without the capability', async () => {
    const r = await controlRelay();
    const w = await releaseWorker(r.attach, undefined, []);
    expect(await post(r.control!, REQ)).toEqual({
      status: 200,
      body: { outcome: 'release_unsupported' },
    });
    expect(w.releases).toHaveLength(0);
    expect(controlLines(r.lines)[0]).toMatchObject({ outcome: 'unsupported' });
  });

  it("answers release_unsupported for a worker's own release_unsupported: error", async () => {
    const r = await controlRelay();
    await releaseWorker(r.attach, answers({ error: 'release_unsupported: not on this worker' }));
    expect(await post(r.control!, REQ)).toEqual({
      status: 200,
      body: { outcome: 'release_unsupported' },
    });
  });

  it.each([
    ['busy: the worker is busy', 503, 'busy'],
    ['invalid-workspace-key: bad', 502, 'failed'],
    ['something else', 502, 'failed'],
  ])('answers a worker error %j with %i %s, not an ack', async (error, code, name) => {
    const r = await controlRelay();
    await releaseWorker(r.attach, answers({ error }));
    const got = await post(r.control!, REQ);
    expect(got.status).toBe(code);
    expect(got.body).toMatchObject({ error: name, message: error });
    expect(got.body.outcome).toBeUndefined();
  });

  it('answers 503 unavailable with no live worker', async () => {
    const r = await controlRelay();
    const got = await post(r.control!, { worker: 'sbx_gone', workspaceKey: 'k' });
    expect(got.status).toBe(503);
    expect(got.body).toMatchObject({ error: 'unavailable' });
    expect(controlLines(r.lines)[0]).toMatchObject({ wrk: 'sbx_gone', outcome: 'error' });
  });

  it("answers 504 at the relay's timeout when the worker never answers", async () => {
    const r = await controlRelay({ timeoutMs: 200 });
    const w = await releaseWorker(r.attach); // records the release, never answers it
    const t0 = Date.now();
    const got = await post(r.control!, REQ);
    expect(got.status).toBe(504);
    expect(got.body).toMatchObject({ error: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(w.releases).toHaveLength(1);
  });

  it('caps releases in flight: one past the cap is 503 busy, never sent', async () => {
    const r = await controlRelay({ timeoutMs: 1000 });
    const w = await releaseWorker(r.attach); // silent: every release stays in flight
    const held = Array.from({ length: CONTROL_RELEASE_MAX_INFLIGHT }, () => post(r.control!, REQ));
    await new Promise((res) => setTimeout(res, 300));
    const over = await post(r.control!, REQ);
    expect(over.status).toBe(503);
    expect(over.body).toMatchObject({ error: 'busy' });
    expect(w.releases).toHaveLength(CONTROL_RELEASE_MAX_INFLIGHT);
    await Promise.all(held);
  });
});

describe('the release bearer at boot (#338)', () => {
  it('is required with the listener on', () => {
    expect(() => makeReleaseTokenValidator({})).toThrow(
      /MOCA_RELAY_RELEASE_TOKEN is required with MOCA_RELAY_CONTROL_ADDR/,
    );
    expect(() => makeReleaseTokenValidator({ MOCA_RELAY_RELEASE_TOKEN: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('reads the credential file under CREDENTIALS_DIRECTORY', () => {
    const d = dirWith({ MOCA_RELAY_RELEASE_TOKEN: `${RELEASE}\n` });
    const v = makeReleaseTokenValidator({ CREDENTIALS_DIRECTORY: d });
    expect(v.token).toBe(RELEASE);
    expect(v.validate(RELEASE)).toBe(true);
    expect(v.validate(`${RELEASE}x`)).toBe(false);
    expect(v.validate(undefined)).toBe(false);
  });

  it.each([
    ['MOCA_RELAY_EXEC_TOKEN', { MOCA_RELAY_EXEC_TOKEN: RELEASE }],
    ['SH_RELAY_TOKEN', { SH_RELAY_TOKEN: RELEASE }],
    ['SH_RELAY_TOKEN_sbx_default', { SH_RELAY_TOKEN_sbx_default: RELEASE }],
  ])('refuses to boot when it equals %s, naming the variable and never the value', (name, env) => {
    let msg = '';
    try {
      makeReleaseTokenValidator({ MOCA_RELAY_RELEASE_TOKEN: RELEASE, ...env });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(
      `MOCA_RELAY_RELEASE_TOKEN must differ from every other relay bearer, but equals ${name}`,
    );
    expect(msg).not.toContain(RELEASE);
  });

  it('refuses to boot when it equals a worker token in SH_RELAY_TOKEN_DIR', () => {
    const d = dirWith({ moca_microvm_0: 'other', moca_microvm_1: `${RELEASE}\n` });
    expect(() =>
      makeReleaseTokenValidator({ MOCA_RELAY_RELEASE_TOKEN: RELEASE, SH_RELAY_TOKEN_DIR: d }),
    ).toThrow(/but equals SH_RELAY_TOKEN_DIR\/moca_microvm_1$/);
    // A missing directory holds no tokens (the mount is optional).
    expect(() =>
      makeReleaseTokenValidator({
        MOCA_RELAY_RELEASE_TOKEN: RELEASE,
        SH_RELAY_TOKEN_DIR: join(d, 'absent'),
      }),
    ).not.toThrow();
  });

  it("the relay's own boot refuses it: startRelay rejects before touching Redis", async () => {
    await expect(
      startRelay({
        port: 0,
        controlAddr: '127.0.0.1:0',
        env: { MOCA_RELAY_EXEC_TOKEN: RELEASE, MOCA_RELAY_RELEASE_TOKEN: RELEASE },
      }),
    ).rejects.toThrow(
      /must differ from every other relay bearer, but equals MOCA_RELAY_EXEC_TOKEN/,
    );
    await expect(
      startRelay({
        port: 0,
        env: {
          MOCA_RELAY_EXEC_TOKEN: HARNESS,
          MOCA_RELAY_CONTROL_ADDR: '127.0.0.1:0',
        },
      }),
    ).rejects.toThrow(/MOCA_RELAY_RELEASE_TOKEN is required/);
  });

  it('a directory token written after boot that equals it is refused at attach', () => {
    const d = dirWith({});
    const v = makeDefaultValidateToken(
      { SH_RELAY_TOKEN_DIR: d, MOCA_RELAY_EXEC_TOKEN: HARNESS },
      { releaseToken: RELEASE },
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(join(d, 'moca_microvm_2'), RELEASE);
    expect(v(RELEASE, 'moca_microvm_2')).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      'relay token for moca_microvm_2 equals the release token; refused',
    );
  });
});
