import { afterEach, describe, expect, it } from 'vitest';
import { sbxMain } from '../src/sbx/cli.js';
import { cleanupTmp, fakeCp, sandbox, SBX, setup, TOKEN } from './helpers/sbx.js';

afterEach(cleanupTmp);

/** The caller's sandboxes: `web` live, and a terminated `old` (whose name a new one may reuse). */
const listing = () => ({
  status: 200,
  body: {
    sandboxes: [
      sandbox({ id: 'sbx-dead', name: 'old', state: 'terminated', reason: 'deleted' }),
      sandbox({ id: SBX, name: 'web' }),
    ],
  },
});

const world = () =>
  fakeCp({
    'GET /v1/sandboxes': listing,
    [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
    [`GET /v1/sandboxes/${SBX}`]: () => ({ status: 200, body: sandbox({ id: SBX, name: 'web' }) }),
  });

describe('a sandbox named by its name rather than its id', () => {
  it('token NAME: looks the name up among your sandboxes, then acts on its id', async () => {
    const { home, env, io } = setup();
    const cp = world();
    expect(await sbxMain(['token', 'web'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(io.outs.join('')).toBe(`${TOKEN.token}\n`);
    const paths = cp.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('GET /v1/sandboxes');
    expect(paths).toContain(`POST /v1/sandboxes/${SBX}/token`);
  });

  it('env NAME: the exports name the id, so SBX_TOKEN_CMD does not follow a reused name', async () => {
    const { home, env, io } = setup();
    const cp = world();
    expect(await sbxMain(['env', 'web'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    const out = io.outs.join('');
    expect(out).toContain(`export SBX_WORKSPACE_KEY='${SBX}'`);
    expect(out).toMatch(new RegExp(`SBX_TOKEN_CMD='[^\\n]* ${SBX}'`));
    expect(out).not.toMatch(/token[^\n]* web'/);
  });

  it('--sandbox NAME works as --sandbox ID does', async () => {
    const { home, env, io } = setup();
    const cp = world();
    const d = { home, fetchImpl: cp.fetchImpl };
    expect(await sbxMain(['token', '--sandbox', 'web'], env, io, d)).toBe(0);
    expect(cp.calls.some((c) => c.path === `/v1/sandboxes/${SBX}/token`)).toBe(true);
  });

  it('an id is used as given: no listing', async () => {
    const { home, env, io } = setup();
    const cp = world();
    expect(await sbxMain(['token', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(cp.calls.some((c) => c.method === 'GET' && c.path === '/v1/sandboxes')).toBe(false);
  });

  it('no live sandbox of the name: exit 1, nothing else asked (a terminated one does not count)', async () => {
    for (const name of ['nope', 'old']) {
      const { home, env, io } = setup();
      const cp = world();
      expect(await sbxMain(['token', name], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(1);
      expect(io.errs.join('\n')).toContain(`no live sandbox named '${name}'`);
      expect(cp.calls.some((c) => c.path.endsWith('/token'))).toBe(false);
    }
  });

  it('two live sandboxes of one name (an older control plane): refused, both ids named', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'GET /v1/sandboxes': () => ({
        status: 200,
        body: {
          sandboxes: [sandbox({ id: SBX, name: 'web' }), sandbox({ id: 'sbx-b', name: 'web' })],
        },
      }),
    });
    expect(await sbxMain(['env', 'web'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(1);
    expect(io.errs.join('\n')).toContain(`${SBX}, sbx-b`);
  });

  it('neither an id nor a name: a usage error before any request', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({});
    for (const bad of ['Web', '../x', '-web']) {
      expect(await sbxMain(['env', bad], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(2);
    }
    expect(cp.calls.filter((c) => c.path.startsWith('/v1/sandboxes'))).toEqual([]);
  });

  it('mode MODE NAME and proc ls NAME take a name in the ID position', async () => {
    for (const argv of [
      ['mode', 'per-exec', 'nope'],
      ['proc', 'ls', 'nope'],
      ['get', 'nope'],
      ['reset', 'nope'],
      ['rm', 'nope'],
      ['egress', 'nope'],
    ]) {
      const { home, env, io } = setup();
      const cp = world();
      expect(await sbxMain(argv, env, io, { home, fetchImpl: cp.fetchImpl }), argv.join(' ')).toBe(
        1,
      );
      expect(io.errs.join('\n'), argv.join(' ')).toContain("no live sandbox named 'nope'");
    }
  });

  it('claude and codex --sandbox NAME pass the resolved id to the mcp server they start', async () => {
    for (const agent of ['claude', 'codex'] as const) {
      const { home, env, io } = setup();
      const calls: string[][] = [];
      const spawn = (args: string[]) => {
        calls.push(args);
        const on: Record<string, (x: never) => void> = {};
        queueMicrotask(() => on.exit?.(0 as never));
        return {
          on(e: 'exit' | 'error', cb: (x: never) => void) {
            on[e] = cb;
            return this;
          },
        };
      };
      const deps =
        agent === 'claude' ? { claude: { spawnClaude: spawn } } : { codex: { spawnCodex: spawn } };
      const cp = world();
      expect(
        await sbxMain([agent, '--sandbox', 'web'], env, io, {
          home,
          fetchImpl: cp.fetchImpl,
          ...deps,
        }),
      ).toBe(0);
      const argv = calls[0]!.join(' ');
      expect(argv).toContain(SBX);
      expect(argv).not.toMatch(/"web"/);
    }
  });
});
