import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { resolvePaths, saveAuth } from '../src/config.js';
import type { Io } from '../src/headless.js';
import { openCallRecord, RUN_LENGTH_FIELDS } from '../src/sbx/call-record.js';

// `mocactl run --record F`: the real runtime and clients over a fake control plane and a fake SSE
// harness (the harness discovered, under a path prefix), every planted secret and text grepped for.
// example.invalid hosts only.

const CP = 'https://cp.example.invalid/api';
const HARNESS = 'https://harness.example.invalid/h';
const PROMPT = 'PLANTED-PROMPT-fix the failing test';
const REPLY = 'PLANTED-REPLY-done, see the patch';
const PATCH = 'diff --git a/PLANTED-PATCH b/PLANTED-PATCH\n+x\n';
// Built at run time, so no JWT-shaped literal sits in the source (the secret scanner flags one).
const jwtOf = (claims: Record<string, unknown>) =>
  [{ alg: 'ES256' }, claims, 'sig']
    .map((p) => Buffer.from(typeof p === 'string' ? p : JSON.stringify(p)).toString('base64url'))
    .join('.');
const API_JWT = jwtOf({ sub: 'github:1' });
const SESSION_JWT = jwtOf({ sid: 's-1' });
const REFRESH = `mrt_${'R'.repeat(43)}`;
const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

function io(): Io & { stdout: () => string; stderr: string[] } {
  let out = '';
  const errs: string[] = [];
  return {
    out: (s) => void (out += s),
    err: (s) => void errs.push(s),
    stdout: () => out,
    stderr: errs,
  };
}

/** A body whose chunks the test sends, and whose end it decides. */
function controlled() {
  let c!: ReadableStreamDefaultController<Uint8Array>;
  const sent: Buffer[] = [];
  const stream = new ReadableStream<Uint8Array>({ start: (ctl) => void (c = ctl) });
  return {
    stream,
    send(s: string) {
      const b = Buffer.from(s, 'utf8');
      sent.push(b);
      c.enqueue(new Uint8Array(b));
    },
    close: () => c.close(),
    fail: (err: unknown) => c.error(err),
    sent: () => Buffer.concat(sent),
  };
}

const frame = (f: Record<string, unknown>) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`;

function rig(turn: (init: RequestInit) => Response, opts: { expired?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mocactl-run-rec-'));
  const env = {
    SH_CONTROL_PLANE_URL: CP,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'state'),
  };
  saveAuth(resolvePaths(env, home), {
    apiToken: API_JWT,
    subject: 'github:1',
    displayName: 'Ada PLANTED-NAME',
    roles: [],
    expiresAt: Math.floor(Date.now() / 1000) + (opts.expired ? -60 : 3600),
    controlPlaneUrl: CP,
    refreshToken: REFRESH,
  });
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    seen.push(`${method} ${url}`);
    const at = (p: string) => url === `${CP}${p}` || url.startsWith(`${CP}${p}?`);
    if (method === 'POST' && at('/v1/auth/token'))
      return Response.json({
        token: jwtOf({ sub: 'github:1', n: 2 }),
        subject: 'github:1',
        displayName: 'Ada PLANTED-NAME',
        roles: [],
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        refreshToken: `mrt_${'N'.repeat(43)}`,
        refreshExpiresAt: 4_000_000_000,
      });
    if (method === 'GET' && at('/v1/discovery'))
      return Response.json({ harnessUrl: HARNESS, sandboxTiers: null, version: '1' });
    if (method === 'GET' && at('/v1/credentials'))
      return Response.json({
        credentials: [
          {
            name: 'anthropic',
            kind: 'anthropic',
            consumer: 'inference',
            destination: { hosts: ['api.example.invalid'] },
            binding: { header: 'x-api-key', format: '{secret}' },
            endpoint: 'https://gw.example.invalid/v1',
          },
        ],
      });
    if (method === 'GET' && at('/v1/models'))
      return Response.json({ credential: 'anthropic', models: [{ id: 'm1' }] });
    if (method === 'POST' && at('/v1/sessions'))
      return Response.json(
        { sessionId: 's-1', token: SESSION_JWT, expiresAt: 4_000_000_000, model: 'm1' },
        { status: 201 },
      );
    if (method === 'POST' && url === `${HARNESS}/v1/turn`) return turn(init);
    if (method === 'POST' && url === `${HARNESS}/v1/turn/cancel`)
      return Response.json({ outcome: 'requested' }, { status: 202 });
    return Response.json({ error: 'not_found', message: `no ${url}` }, { status: 404 });
  }) as typeof fetch;
  const rec = join(home, 'calls.ndjson');
  return { home, env, rec, fetchImpl, seen };
}

const lines = (f: string) =>
  readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** Nothing planted reaches the file: no prompt, reply, patch, token, name or host. */
function clean(f: string) {
  const text = readFileSync(f, 'utf8');
  for (const v of [
    'PLANTED',
    'example',
    'eyJ',
    'mrt_',
    'diff --git',
    API_JWT,
    SESSION_JWT,
    REFRESH,
  ])
    expect(text).not.toContain(v);
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};

describe('mocactl run --record F', () => {
  it('records each attempt to both endpoints, keeps the stream live, and ends it with its digest', async () => {
    const body = controlled();
    const r = rig(
      () => new Response(body.stream, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const o = io();
    const done = main(['run', PROMPT, '--record', r.rec], r.env, o, { fetchImpl: r.fetchImpl });
    await until(() => r.seen.some((s) => s.endsWith('/h/v1/turn')));
    body.send(frame({ type: 'text', delta: REPLY }));
    // Live: the first frame reaches stdout while the stream is still open.
    await until(() => o.stdout().includes(REPLY));
    const mid = lines(r.rec);
    expect(mid.at(-1)).toMatchObject({ endpoint: 'harness', path: '/v1/turn', stream: true });
    expect(mid.some((l) => l.event === 'stream_end')).toBe(false);
    body.send(
      frame({
        type: 'done',
        sessionId: 's-1',
        stopReason: 'stop',
        workspace: { patch: PATCH, patchSha256: sha(PATCH), patchBytes: PATCH.length },
      }),
    );
    body.close();
    expect(await done).toBe(0);

    expect(statSync(r.rec).mode & 0o777).toBe(0o600);
    const l = lines(r.rec);
    expect(l.map((x) => `${x.endpoint ?? ''} ${x.method ?? x.event} ${x.path ?? ''}`)).toEqual([
      'control-plane GET /v1/credentials',
      'control-plane GET /v1/models?credential=anthropic',
      // The session options read the discovery twice: the sandbox tier, then the sandbox template.
      'control-plane GET /v1/discovery',
      'control-plane GET /v1/discovery',
      'control-plane POST /v1/sessions',
      'control-plane GET /v1/discovery',
      'harness POST /v1/turn',
      ' stream_end ',
    ]);
    expect(new Set(l.map((x) => x.command))).toEqual(new Set(['run']));
    expect(new Set(l.map((x) => x.invocation)).size).toBe(1);
    // The session's id, model and times stay; its token is a hash.
    const created = l[4]!.answer as Record<string, unknown>;
    expect(created).toMatchObject({ sessionId: 's-1', model: 'm1', expiresAt: 4_000_000_000 });
    expect(created.token).toBe(sha(SESSION_JWT));
    // The credential's name stays; its hosts and endpoint are lengths.
    const cred = (l[0]!.answer as { credentials: Record<string, unknown>[] }).credentials[0]!;
    expect(cred).toMatchObject({
      name: 'anthropic',
      endpoint: { length: 'https://gw.example.invalid/v1'.length },
    });
    expect((cred.destination as { hosts: unknown }).hosts).toEqual({
      length: JSON.stringify(['api.example.invalid']).length,
    });
    // The turn's request: its session id, the prompt as its length.
    expect(l[6]!.request).toEqual({ sessionId: 's-1', prompt: { length: PROMPT.length } });
    expect(l[6]).toMatchObject({ status: 200, seq: 7, try: 1 });
    expect(l[6]!.answer).toBeUndefined();
    const end = l[7]!;
    expect(end).toMatchObject({ seq: 7, event: 'stream_end', frames: 2 });
    expect(end.bytes).toBe(body.sent().length);
    expect(end.sha256).toBe(sha(body.sent()));
    expect(end.error).toBeUndefined();
    expect(String(end.endedAt)).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    clean(r.rec);
  });

  it('a turn answered as JSON keeps its patch digest and drops its reply and patch; a refresh is hashed', async () => {
    const r = rig(
      () =>
        Response.json({
          sessionId: 's-1',
          response: REPLY,
          stopReason: 'stop',
          sandbox: { id: 'sbx-1', tier: 'microvm', template: 'tpl@b-1' },
          workspace: { baseline: 'abc123', patch: PATCH, patchSha256: sha(PATCH), patchBytes: 40 },
        }),
      { expired: true },
    );
    const o = io();
    expect(
      await main(['run', PROMPT, '--record', r.rec], r.env, o, { fetchImpl: r.fetchImpl }),
    ).toBe(0);
    expect(o.stdout()).toContain(REPLY);
    const l = lines(r.rec);
    // The expired login's refresh comes first: both refresh tokens and the new API token hashed.
    expect(l[0]).toMatchObject({
      endpoint: 'control-plane',
      method: 'POST',
      path: '/v1/auth/token',
    });
    expect(l[0]!.request).toEqual({ grant_type: 'refresh_token', refresh_token: sha(REFRESH) });
    expect(l[0]!.answer).toMatchObject({
      token: expect.stringMatching(/^sha256:/),
      refreshToken: expect.stringMatching(/^sha256:/),
      displayName: { length: 'Ada PLANTED-NAME'.length },
      subject: 'github:1',
    });
    const turn = l.at(-1)!;
    expect(turn.answer).toEqual({
      sessionId: 's-1',
      response: { length: REPLY.length },
      stopReason: 'stop',
      sandbox: { id: 'sbx-1', tier: 'microvm', template: 'tpl@b-1' },
      workspace: {
        baseline: 'abc123',
        patch: { length: PATCH.length },
        patchSha256: sha(PATCH),
        patchBytes: 40,
      },
    });
    clean(r.rec);
  });

  it('an aborted turn ends its stream line with the error', async () => {
    const body = controlled();
    const r = rig((init) => {
      init.signal?.addEventListener('abort', () =>
        body.fail(new DOMException('This operation was aborted', 'AbortError')),
      );
      return new Response(body.stream, { headers: { 'content-type': 'text/event-stream' } });
    });
    const ac = new AbortController();
    const o = io();
    const done = main(['run', PROMPT, '--record', r.rec], r.env, o, {
      fetchImpl: r.fetchImpl,
      signal: ac.signal,
    });
    await until(() => r.seen.some((s) => s.endsWith('/h/v1/turn')));
    body.send(frame({ type: 'text', delta: REPLY }));
    await until(() => o.stdout().includes(REPLY));
    ac.abort();
    expect(await done).toBe(130);
    const end = lines(r.rec).find((x) => x.event === 'stream_end')!;
    expect(end).toMatchObject({ seq: 7, frames: 1, error: 'AbortError' });
    expect(end.sha256).toBe(sha(body.sent()));
    clean(r.rec);
  });

  it('refuses a record readable by others, and --record on another command', async () => {
    const r = rig(() => Response.json({}));
    writeFileSync(r.rec, '');
    chmodSync(r.rec, 0o644);
    const o = io();
    expect(
      await main(['run', PROMPT, '--record', r.rec], r.env, o, { fetchImpl: r.fetchImpl }),
    ).toBe(2);
    expect(o.stderr.join('\n')).toContain('mode 644: it must be 0600');
    expect(r.seen).toEqual([]);
    expect(await main(['sessions', '--record', r.rec], r.env, o, { fetchImpl: r.fetchImpl })).toBe(
      2,
    );
    expect(o.stderr.join('\n')).toContain('--record only applies to `mocactl run`');
    expect(r.seen).toEqual([]);
  });
});

describe('the stream pass-through', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'mocactl-rec-stream-'));

  it('counts NDJSON lines (the last without a newline) and a failed stream names its error', async () => {
    const f = join(dir(), 'r.ndjson');
    const rec = openCallRecord(f, 'run', Date.now, { lengthFields: RUN_LENGTH_FIELDS });
    if ('error' in rec) throw new Error(rec.error);
    const chunks = ['{"a":1}\n{"b"', ':2}\r\n\n{"c":3}'];
    const fetchOk = (async () =>
      new Response(chunks.join(''), {
        headers: { 'content-type': 'application/x-ndjson' },
      })) as unknown as typeof fetch;
    const wrapped = rec.wrapEndpoints(fetchOk, () => [{ endpoint: 'control-plane', url: CP }]);
    const text = await (await wrapped(`${CP}/v1/x?format=ndjson`)).text();
    expect(text).toBe(chunks.join(''));
    const body = controlled();
    const fetchBad = (async () =>
      new Response(body.stream, {
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    const res = await rec.wrapEndpoints(fetchBad, () => [])(
      `https://other.example.invalid/v1/turn`,
    );
    body.send(frame({ type: 'text', delta: REPLY }));
    const err = Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
    body.fail(err);
    await expect(res.text()).rejects.toBe(err);
    rec.close();
    const l = lines(f);
    expect(l[0]).toMatchObject({
      endpoint: 'control-plane',
      path: '/v1/x?format=ndjson',
      stream: true,
    });
    expect(l[1]).toMatchObject({
      seq: 1,
      event: 'stream_end',
      frames: 3,
      bytes: Buffer.byteLength(chunks.join('')),
    });
    expect(l[1]!.sha256).toBe(sha(chunks.join('')));
    expect(l[2]).toMatchObject({ endpoint: 'other', path: '/v1/turn', stream: true });
    expect(l[3]).toMatchObject({ seq: 2, event: 'stream_end', frames: 1, error: 'UND_ERR_SOCKET' });
    clean(f);
  });
});
