import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sbxMain } from '../src/sbx/cli.js';
import { fakeCp, SBX, setup } from './helpers/sbx.js';

// `mocactl sbx egress [ID] [--json | --ndjson | --verify]`. example.com hosts only.
const E1 = {
  time: '2026-11-08T12:00:00Z',
  via: 'moca-egress',
  sid: SBX,
  host: 'pypi.example.com',
  method: 'CONNECT',
  status: 200,
  bytes_up: 10,
  bytes_down: 20,
  decision: 'tunnel',
};
const E2 = { ...E1, host: 'files.example.com', status: 403, decision: 'destination_denied' };
const NDJSON = `${JSON.stringify(E1)}\n${JSON.stringify(E2)}\n`;
const SHA = `sha256:${createHash('sha256').update(NDJSON).digest('hex')}`;
const summary = (over: Record<string, unknown> = {}) => ({
  byHost: {
    'pypi.example.com': { count: 1, decisions: { tunnel: 1 }, bytesUp: 10, bytesDown: 20 },
    'files.example.com': {
      count: 1,
      decisions: { destination_denied: 1 },
      bytesUp: 10,
      bytesDown: 20,
    },
  },
  total: 2,
  dropped: 0,
  droppedBy: { proxy: 0, cap: 0, invalid: 0 },
  complete: true,
  sealed: false,
  sha256: SHA,
  ...over,
});
const PATH = `/v1/sandboxes/${SBX}/egress`;

describe('mocactl sbx egress', () => {
  it('prints the summary per host, then completeness and the digest', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`GET ${PATH}`]: () => ({
        status: 200,
        body: { events: [E1, E2], next: null, summary: summary() },
      }),
    });
    expect(await sbxMain(['egress', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    const out = io.outs.join('');
    expect(out).toMatch(
      /^files\.example\.com +1 {2}up 10 B, down 20 B {2}\(destination_denied 1\)\n/,
    );
    expect(out).toContain('pypi.example.com');
    expect(out).toContain(`2 events; complete; open (not sealed yet); ${SHA}\n`);
    expect(cp.calls.map((c) => c.path)).toEqual([`${PATH}?limit=1000`]);
  });

  it('says sealed once the log is final, and nothing from a server that does not say', async () => {
    const { home, env, io } = setup();
    let sealed: boolean | undefined = true;
    const cp = fakeCp({
      [`GET ${PATH}`]: () => ({
        status: 200,
        body: { events: [], next: null, summary: { ...summary(), sealed } },
      }),
    });
    expect(await sbxMain(['egress', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(io.outs.join('')).toContain(`2 events; complete; sealed; ${SHA}\n`);
    io.outs.length = 0;
    sealed = undefined;
    expect(await sbxMain(['egress', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(io.outs.join('')).toContain(`2 events; complete; ${SHA}\n`);
  });

  it('says INCOMPLETE with the drop count', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`GET ${PATH}`]: () => ({
        status: 200,
        body: { events: [], next: null, summary: summary({ dropped: 4, complete: false }) },
      }),
    });
    expect(await sbxMain(['egress', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(io.outs.join('')).toContain('INCOMPLETE: 4 dropped; open (not sealed yet); ');
  });

  it('--json reads every page, then prints the events and the summary', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`GET ${PATH}`]: (req) =>
        req.path.includes('after=1-0')
          ? { status: 200, body: { events: [E2], next: null, summary: summary() } }
          : { status: 200, body: { events: [E1], next: '1-0', summary: summary() } },
    });
    expect(
      await sbxMain(['egress', SBX, '--json'], env, io, { home, fetchImpl: cp.fetchImpl }),
    ).toBe(0);
    expect(JSON.parse(io.outs.join(''))).toEqual({ events: [E1, E2], summary: summary() });
    expect(cp.calls.map((c) => c.path)).toEqual([
      `${PATH}?limit=1000`,
      `${PATH}?after=1-0&limit=1000`,
    ]);
  });

  it("--json takes the first page's summary (later pages carry null), and stops on a repeated next", async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`GET ${PATH}`]: (req) =>
        req.path.includes('after=1-0')
          ? { status: 200, body: { events: [E2], next: null, summary: null } }
          : { status: 200, body: { events: [E1], next: '1-0', summary: summary() } },
    });
    expect(
      await sbxMain(['egress', SBX, '--json'], env, io, { home, fetchImpl: cp.fetchImpl }),
    ).toBe(0);
    expect(JSON.parse(io.outs.join(''))).toEqual({ events: [E1, E2], summary: summary() });
    io.outs.length = 0;
    // A first page without its summary is an error, not a crash.
    const bare = fakeCp({
      [`GET ${PATH}`]: () => ({ status: 200, body: { events: [], next: null, summary: null } }),
    });
    expect(await sbxMain(['egress', SBX], env, io, { home, fetchImpl: bare.fetchImpl })).toBe(1);
    expect(io.errs.join('\n')).toMatch(/no egress summary on the first page/);
    const loop = fakeCp({
      [`GET ${PATH}`]: () => ({
        status: 200,
        body: { events: [E1], next: '1-0', summary: summary() },
      }),
    });
    expect(
      await sbxMain(['egress', SBX, '--json'], env, io, { home, fetchImpl: loop.fetchImpl }),
    ).toBe(1);
    expect(io.errs.join('\n')).toMatch(/repeated an egress page's next/);
    expect(io.outs.join('')).toBe('');
    expect(loop.calls.filter((c) => c.path.startsWith(PATH))).toHaveLength(2);
  });

  it('prints a server number that is not a number as ?, never its text', async () => {
    const { home, env, io } = setup();
    const bad = '\u001b]0;x\u0007';
    const cp = fakeCp({
      [`GET ${PATH}`]: () => ({
        status: 200,
        body: {
          events: [],
          next: null,
          summary: summary({
            byHost: {
              'a.example.com': {
                count: bad,
                decisions: { tunnel: bad },
                bytesUp: bad,
                bytesDown: 1,
              },
            },
            total: bad,
            dropped: bad,
            complete: false,
          }),
        },
      }),
    });
    expect(await sbxMain(['egress', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    const out = io.outs.join('');
    expect(out).not.toContain('\u001b');
    expect(out).toMatch(/a\.example\.com +\? {2}up \? B, down 1 B {2}\(tunnel \?\)\n/);
    expect(out).toContain('? events; INCOMPLETE: ? dropped; ');
  });

  it('--ndjson prints the log byte for byte, so its sha256 is the summary digest', async () => {
    const { home, env, io } = setup();
    const fetchImpl = (async (input: string | URL) => {
      expect(String(input)).toContain(`${PATH}?format=ndjson`);
      return new Response(NDJSON, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    }) as typeof fetch;
    expect(await sbxMain(['egress', SBX, '--ndjson'], env, io, { home, fetchImpl })).toBe(0);
    const bytes = Buffer.concat(io.outB);
    expect(bytes.toString('utf8')).toBe(NDJSON);
    expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(SHA);
  });

  it('--verify checks the log served against its summary: exit 0 only when both match', async () => {
    const { home, env, io } = setup();
    let summarySha = SHA;
    const order: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const ndjson = String(input).includes('format=ndjson');
      order.push(ndjson ? 'ndjson' : 'summary');
      return ndjson
        ? new Response(NDJSON, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
        : new Response(
            JSON.stringify({ events: [], next: null, summary: summary({ sha256: summarySha }) }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
    }) as typeof fetch;
    expect(await sbxMain(['egress', SBX, '--verify'], env, io, { home, fetchImpl })).toBe(0);
    expect(io.outs.join('')).toBe(`verified: 2 events, ${SHA}; open (not sealed yet)\n`);
    // The log first, then the summary: an open log that grows in between shows as open, not damage.
    expect(order).toEqual(['ndjson', 'summary']);
    io.outs.length = 0;
    summarySha = `sha256:${'0'.repeat(64)}`;
    expect(await sbxMain(['egress', SBX, '--verify', '--json'], env, io, { home, fetchImpl })).toBe(
      1,
    );
    expect(JSON.parse(io.outs.join(''))).toMatchObject({ verified: false, sha256: SHA, lines: 2 });
  });

  it('--verify on an open log that gained events while it was read says so (exit 1)', async () => {
    const { home, env, io } = setup();
    const fetchImpl = (async (input: string | URL) =>
      String(input).includes('format=ndjson')
        ? new Response(NDJSON, { status: 200 })
        : new Response(
            JSON.stringify({
              events: [],
              next: null,
              summary: summary({ total: 3, sha256: `sha256:${'1'.repeat(64)}` }),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )) as typeof fetch;
    expect(await sbxMain(['egress', SBX, '--verify'], env, io, { home, fetchImpl })).toBe(1);
    expect(io.outs.join('')).toMatch(
      /^NOT verified: the log is still open \(not sealed\) and gained events while it was read \(2 read, 3 now\)/,
    );
  });

  it('--ndjson and --verify use the bytes as served, not a decoded string', async () => {
    const { home, env, io } = setup();
    // A BOM and a byte that is not UTF-8: a decoder would strip the one and replace the other.
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"host":"a.example.com"}'),
      Buffer.from([0xff, 0x0a]),
    ]);
    const sha = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    const fetchImpl = (async (input: string | URL) =>
      String(input).includes('format=ndjson')
        ? new Response(raw, { status: 200 })
        : new Response(
            JSON.stringify({
              events: [],
              next: null,
              summary: summary({ total: 1, sha256: sha, sealed: true }),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )) as typeof fetch;
    expect(await sbxMain(['egress', SBX, '--ndjson'], env, io, { home, fetchImpl })).toBe(0);
    expect(Buffer.concat(io.outB).equals(raw)).toBe(true);
    expect(await sbxMain(['egress', SBX, '--verify'], env, io, { home, fetchImpl })).toBe(0);
    expect(io.outs.join('')).toBe(`verified: 1 events, ${sha}; sealed\n`);
  });

  it('--verify prints a server number that is not a number as ?, never its text', async () => {
    const { home, env, io } = setup();
    const fetchImpl = (async (input: string | URL) =>
      String(input).includes('format=ndjson')
        ? new Response(NDJSON, { status: 200 })
        : new Response(
            JSON.stringify({
              events: [],
              next: null,
              summary: summary({ total: '\u001b[2Jx', sealed: true }),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )) as typeof fetch;
    expect(await sbxMain(['egress', SBX, '--verify'], env, io, { home, fetchImpl })).toBe(1);
    expect(io.outs.join('')).toContain('the summary names ?, ');
    expect(io.outs.join('')).not.toContain('\u001b');
  });

  it("is another user's sandbox: the same not-found as sbx token", async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`GET ${PATH}`]: () => ({
        status: 404,
        body: { error: 'sandbox_not_found', message: 'no such sandbox' },
      }),
    });
    expect(await sbxMain(['egress', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(1);
    expect(io.errs.join('\n')).toMatch(/no such sandbox/);
  });

  it('refuses --json with --ndjson, --verify with --ndjson, either elsewhere, and a malformed id, before any request', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({});
    const run = (argv: string[]) => sbxMain(argv, env, io, { home, fetchImpl: cp.fetchImpl });
    expect(await run(['egress', SBX, '--json', '--ndjson'])).toBe(2);
    expect(await run(['egress', SBX, '--verify', '--ndjson'])).toBe(2);
    expect(await run(['ls', '--verify'])).toBe(2);
    expect(await run(['ls', '--ndjson'])).toBe(2);
    expect(await run(['egress', '../../etc'])).toBe(2);
    expect(await run(['egress', SBX, 'extra'])).toBe(2);
    expect(cp.calls.filter((c) => c.path.startsWith('/v1/sandboxes'))).toEqual([]);
  });
});
