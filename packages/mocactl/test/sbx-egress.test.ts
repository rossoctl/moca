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
    expect(out).toContain(`2 events; complete; ${SHA}\n`);
    expect(cp.calls.map((c) => c.path)).toEqual([`${PATH}?limit=1000`]);
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
    expect(io.outs.join('')).toContain('INCOMPLETE: 4 dropped');
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
    const fetchImpl = (async (input: string | URL) =>
      String(input).includes('format=ndjson')
        ? new Response(NDJSON, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
        : new Response(
            JSON.stringify({ events: [], next: null, summary: summary({ sha256: summarySha }) }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )) as typeof fetch;
    expect(await sbxMain(['egress', SBX, '--verify'], env, io, { home, fetchImpl })).toBe(0);
    expect(io.outs.join('')).toBe(`verified: 2 events, ${SHA}\n`);
    io.outs.length = 0;
    summarySha = `sha256:${'0'.repeat(64)}`;
    expect(await sbxMain(['egress', SBX, '--verify', '--json'], env, io, { home, fetchImpl })).toBe(
      1,
    );
    expect(JSON.parse(io.outs.join(''))).toMatchObject({ verified: false, sha256: SHA, lines: 2 });
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
