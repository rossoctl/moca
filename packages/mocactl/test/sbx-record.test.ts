import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCallRecord, redact } from '../src/sbx/call-record.js';
import { sbxMain } from '../src/sbx/cli.js';
import {
  cleanupTmp,
  fakeCp,
  harness,
  sandbox,
  SBX,
  setup,
  tmp,
  TOKEN,
  URL_,
} from './helpers/sbx.js';

// `mocactl sbx … --record F`: one NDJSON line per HTTP attempt, with no token, host or free text.
// example.invalid hosts only.

afterEach(cleanupTmp);

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const lines = (f: string) =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
/** No JWT, refresh token or host in the file. */
const noSecret = (f: string) => {
  const text = readFileSync(f, 'utf8');
  expect(text).not.toMatch(JWT_RE);
  expect(text).not.toContain('mrt_');
  expect(text).not.toContain('example.invalid');
};

describe('redact', () => {
  it('hashes token fields and token-shaped strings, measures hosts and URLs, keeps the rest', () => {
    const rt = `mrt_${'A'.repeat(43)}`;
    const out = redact({
      profile: 'sandbox',
      token: 'opaque',
      gateRecord: { passed: true },
      harnessUrl: 'https://harness.example.invalid',
      execEndpoint: 'sbx-exec.example.invalid:443',
      links: ['http://cp.example.invalid/v1/x', 'not a url'],
      message: `refresh ${rt} was refused`,
      note: TOKEN.token,
      reason: { message: 'failed at registry.example.invalid', step: 'build' },
      plain: 'plain text',
      n: 3,
    }) as Record<string, unknown>;
    expect(out.token).toBe(sha('opaque'));
    expect(out.gateRecord).toBe(sha(JSON.stringify({ passed: true })));
    expect(out.harnessUrl).toEqual({ length: 'https://harness.example.invalid'.length });
    expect(out.execEndpoint).toEqual({ length: 'sbx-exec.example.invalid:443'.length });
    expect(out.links).toEqual([{ length: 'http://cp.example.invalid/v1/x'.length }, 'not a url']);
    expect(out.message).toBe(sha(`refresh ${rt} was refused`));
    expect(out.note).toBe(sha(TOKEN.token));
    expect(out.reason).toEqual({
      message: { length: 'failed at registry.example.invalid'.length },
      step: 'build',
    });
    expect(out).toMatchObject({ profile: 'sandbox', plain: 'plain text', n: 3 });
    expect(JSON.stringify(out)).not.toContain('example.invalid');
  });

  it("keeps a request's reason as its length; an answer's top-level reason is a code", () => {
    expect(redact({ reason: 'cleaning up after the run' }, undefined, undefined, true)).toEqual({
      reason: { length: 'cleaning up after the run'.length },
    });
    expect(redact({ reason: 'deleted' })).toEqual({ reason: 'deleted' });
  });
});

describe('the record file', () => {
  it('one line per attempt: seq, try for a retry in a row, the path only, Retry-After', async () => {
    const f = join(tmp('sbx-rec-'), 'r.ndjson');
    let t = Date.parse('2026-01-01T00:00:00Z');
    const rec = openCallRecord(f, 'sbx test', () => (t += 1000));
    if ('error' in rec) throw new Error(rec.error);
    let n = 0;
    const fetchImpl = (async () =>
      n++ === 0
        ? new Response(JSON.stringify({ error: 'busy' }), {
            status: 503,
            headers: { 'content-type': 'application/json', 'retry-after': '3' },
          })
        : Response.json({ ok: true })) as unknown as typeof fetch;
    const wrapped = rec.wrap(fetchImpl, `${URL_}/api/`);
    const post = { method: 'POST', body: JSON.stringify({ name: 'web' }) };
    expect((await wrapped(`${URL_}/api/v1/things?x=1`, post)).status).toBe(503);
    expect((await wrapped(`${URL_}/api/v1/things?x=1`, post)).status).toBe(200);
    await wrapped(`${URL_}/api/v1/other`);
    const failing = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    await expect(rec.wrap(failing, URL_)(`${URL_}/v1/other`)).rejects.toThrow('fetch failed');
    rec.close();
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const l = lines(f);
    expect(l.map((x) => [x.seq, x.try, x.method, x.path, x.status ?? x.error])).toEqual([
      [1, 1, 'POST', '/v1/things?x=1', 503],
      [2, 2, 'POST', '/v1/things?x=1', 200],
      [3, 1, 'GET', '/v1/other', 200],
      [4, 2, 'GET', '/v1/other', 'ECONNREFUSED'],
    ]);
    expect(l[0]).toMatchObject({
      command: 'sbx test',
      request: { name: 'web' },
      answer: { error: 'busy' },
      retryAfter: '3',
      requestAt: '2026-01-01T00:00:01.000Z',
      answerAt: '2026-01-01T00:00:02.000Z',
    });
    expect(l[1]!.retryAfter).toBeUndefined();
    expect(new Set(l.map((x) => x.invocation)).size).toBe(1);
    noSecret(f);
  });

  it('writes a line past PIPE_BUF whole, under a lock it removes', async () => {
    const dir = tmp('sbx-rec-');
    const f = join(dir, 'r.ndjson');
    const rec = openCallRecord(f, 'sbx ls');
    if ('error' in rec) throw new Error(rec.error);
    const big = { sandboxes: Array.from({ length: 200 }, (_, i) => sandbox({ name: `w${i}` })) };
    const wrapped = rec.wrap((async () => Response.json(big)) as unknown as typeof fetch, URL_);
    await wrapped(`${URL_}/v1/sandboxes`);
    rec.close();
    const text = readFileSync(f, 'utf8');
    expect(Buffer.byteLength(text)).toBeGreaterThan(4096);
    expect(text.endsWith('\n') && text.indexOf('\n') === text.length - 1).toBe(true);
    expect(lines(f)[0]!.answer).toEqual(big);
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it('refuses an existing record readable by others, or not a file; appends to a 0600 one', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({ 'GET /v1/sandboxes': () => ({ status: 200, body: { sandboxes: [] } }) });
    const dir = tmp('sbx-rec-');
    const f = join(dir, 'r.ndjson');
    writeFileSync(f, '');
    chmodSync(f, 0o644);
    const deps = { home, fetchImpl: cp.fetchImpl };
    expect(await sbxMain(['ls', '--record', f], env, io, deps)).toBe(2);
    expect(io.errs.join('\n')).toContain('mode 644: it must be 0600');
    expect(await sbxMain(['ls', '--record', dir], env, io, deps)).toBe(2);
    expect(cp.calls).toEqual([]);
    chmodSync(f, 0o600);
    expect(await sbxMain(['ls', '--record', f], env, io, deps)).toBe(0);
    expect(await sbxMain(['ls', '--record', f], env, io, deps)).toBe(0);
    const l = lines(f);
    expect(l.map((x) => x.seq)).toEqual([1, 1]);
    expect(l[0]!.invocation).not.toBe(l[1]!.invocation);
  });
});

describe('mocactl sbx --record F', () => {
  it('a refresh, a minted sandbox token and a token-shaped value are hashed, never kept', async () => {
    const { home, env, io } = setup({ loggedIn: true, expired: true });
    const f = join(tmp('sbx-rec-'), 'r.ndjson');
    const cp = fakeCp({
      'POST /v1/auth/token': () => ({
        status: 200,
        body: {
          token: TOKEN.token.replace('sig', 's2'),
          subject: 'github:1',
          roles: [],
          expiresAt: 4_000_000_000,
          refreshToken: `mrt_${'z'.repeat(43)}`,
          refreshExpiresAt: 4_000_000_000,
        },
      }),
      'POST /v1/sandboxes': () => ({
        status: 201,
        body: { ...sandbox(), note: TOKEN.token, nested: [{ any: `mrt_${'q'.repeat(43)}` }] },
      }),
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
    });
    const deps = { home, fetchImpl: cp.fetchImpl };
    expect(await sbxMain(['create', '--template', 'node22', '--record', f], env, io, deps)).toBe(0);
    const l = lines(f);
    expect(l.map((x) => `${x.command} ${x.method} ${x.path} ${x.status}`)).toEqual([
      'sbx create POST /v1/auth/token 200',
      'sbx create POST /v1/sandboxes 201',
    ]);
    expect((l[0]!.request as { refresh_token: string }).refresh_token).toBe(sha('mrt_x'));
    expect(l[0]!.answer).toMatchObject({
      token: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      refreshToken: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      subject: 'github:1',
    });
    expect(l[1]!.request).toEqual({ template: 'node22' });
    const created = l[1]!.answer as Record<string, unknown>;
    expect(created).toMatchObject({ id: SBX, template: 'node22', note: sha(TOKEN.token) });
    expect((created.nested as { any: string }[])[0]!.any).toMatch(/^sha256:/);
    // A sandbox token minted for a command (env here; run and put alike): hashed, its host measured.
    expect(await sbxMain(['env', SBX, '--record', f], env, io, deps)).toBe(0);
    const minted = lines(f).at(-1)!;
    expect(minted).toMatchObject({ command: 'sbx env', path: `/v1/sandboxes/${SBX}/token` });
    expect((minted.answer as Record<string, unknown>).token).toBe(sha(TOKEN.token));
    expect((minted.answer as Record<string, unknown>).execEndpoint).toEqual({
      length: TOKEN.execEndpoint.length,
    });
    noSecret(f);
  });

  it('is refused on the commands that handle a secret, before any request', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({});
    const f = join(tmp('sbx-rec-'), 'r.ndjson');
    const deps = { home, fetchImpl: cp.fetchImpl };
    for (const argv of [
      ['token', SBX],
      ['login'],
      ['logout'],
      ['credentials'],
      ['credentials', 'delete', 'gh'],
    ])
      expect(await sbxMain([...argv, '--record', f], env, io, deps)).toBe(2);
    expect(io.errs.join('\n')).toContain('token takes no --record (it would record a secret)');
    expect(io.errs.join('\n')).toContain('credentials takes no --record');
    expect(cp.calls).toEqual([]);
    expect(existsSync(f)).toBe(false);
  });

  it('records every HTTP call each API command makes', async () => {
    const h = harness();
    writeFileSync(join(h.r, 'notes.md'), 'changed\n');
    const f = join(tmp('sbx-rec-'), 'r.ndjson');
    const run = (argv: string[]) =>
      // --record first: after `run --`, every word is the command's.
      sbxMain(['--record', f, ...argv], h.env, h.io, {
        home: h.home,
        fetchImpl: h.cp.fetchImpl,
        cwd: h.r,
        execFactory: h.ws.factory,
        agentop: async () => ({ code: null, stdout: '', stderr: 'agentop is not on PATH' }),
        claudeVersion: () => undefined,
        stdinIsTTY: false,
        readStdin: async () => 'true\n',
        readStdinBytes: async () => Buffer.from('x\n'),
      });
    const seen: string[] = [];
    for (const argv of [
      ['templates'],
      ['up', '--no-agent-config'],
      ['ls'],
      ['create', '--name', 'other'],
      ['env'],
      ['run', '--', 'true'],
      ['put', 'notes.txt'],
      ['push', '--force'],
      ['pull'],
      ['doctor'],
      ['rm', '--force', '--keep-config'],
    ]) {
      const calls = h.cp.calls.length;
      const before = lines(f).length;
      await run(argv);
      const made = h.cp.calls.slice(calls).map((c) => `${c.method} ${c.path}`);
      const recorded = lines(f).slice(before);
      // Every call the control plane saw is a line, in order, under this command's name.
      expect(made.length, argv.join(' ')).toBeGreaterThan(0);
      expect(recorded.map((x) => `${x.method} ${x.path}`)).toEqual(made);
      expect(new Set(recorded.map((x) => x.command))).toEqual(new Set([`sbx ${argv[0]}`]));
      seen.push(argv[0]!);
    }
    expect(seen).toHaveLength(11);
    noSecret(f);
  });
});
