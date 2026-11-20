import { describe, expect, it } from 'vitest';
import { codexArgs, FORWARDED_ENV, serverOverride } from '../src/sbx/codex.js';
import { sbxMain } from '../src/sbx/cli.js';
import { fakeCp, SBX, setup, TOKEN } from './helpers/sbx.js';

/** A stand-in for the `codex` child: records its argv, then reports an exit code or an error. */
function fakeCodex(outcome: { code?: number; err?: NodeJS.ErrnoException } = { code: 0 }) {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      spawnCodex: (args: string[]) => {
        calls.push(args);
        const handlers: Record<string, (x: never) => void> = {};
        queueMicrotask(() => {
          if (outcome.err) handlers.error?.(outcome.err as never);
          else handlers.exit?.((outcome.code ?? 0) as never);
        });
        return {
          on(e: 'exit' | 'error', cb: (x: never) => void) {
            handlers[e] = cb;
            return this;
          },
        };
      },
    },
  };
}

const mint = () =>
  fakeCp({ [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }) });

describe('mocactl sbx codex (#593)', () => {
  it('registers the sandbox MCP server with -c, disables the shell tool, and writes no config', async () => {
    const { home, env, io } = setup();
    const c = fakeCodex({ code: 0 });
    const code = await sbxMain(['codex', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      codex: c.deps,
    });
    expect(code).toBe(0);
    expect(c.calls).toHaveLength(1);
    // --sandbox is forwarded to the mcp server codex starts, not dropped.
    expect(c.calls[0]).toEqual(['-c', serverOverride(SBX), '--disable', 'shell_tool']);
    expect(c.calls[0]?.[1]).toContain(`"--sandbox","${SBX}"`);
  });

  it("passes the caller's own arguments through, after ours, so theirs win", async () => {
    const { home, env, io } = setup();
    const c = fakeCodex();
    await sbxMain(
      ['codex', '--sandbox', SBX, '--', '-c', 'model="o3"', 'fix the failing test'],
      env,
      io,
      { home, fetchImpl: mint().fetchImpl, codex: c.deps },
    );
    // Ours first, the user's last: Codex takes the last value for a key.
    expect(c.calls[0]).toEqual([
      '-c',
      serverOverride(SBX),
      '--disable',
      'shell_tool',
      '-c',
      'model="o3"',
      'fix the failing test',
    ]);
  });

  it("exits with codex's own exit code", async () => {
    const { home, env, io } = setup();
    const c = fakeCodex({ code: 3 });
    const code = await sbxMain(['codex', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      codex: c.deps,
    });
    expect(code).toBe(3);
  });

  it('says how to install Codex, and the command to run by hand, when it is not on PATH', async () => {
    const { home, env, io } = setup();
    const err: NodeJS.ErrnoException = new Error('spawn codex ENOENT');
    err.code = 'ENOENT';
    const c = fakeCodex({ err });
    const code = await sbxMain(['codex', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      codex: c.deps,
    });
    expect(code).toBe(1);
    const said = io.errs.join('\n');
    expect(said).toMatch(/codex is not on PATH/);
    expect(said).toMatch(/@openai\/codex/);
    // The escape hatch is the real command, so it can be copied.
    expect(said).toContain(serverOverride(SBX));
  });

  it('asks codex to forward the environment the mcp server needs, since codex passes none', () => {
    // Codex gives a stdio server only its own allowlist, so without env_vars the server would
    // read a different login and target a different control plane than the launcher (#639 review).
    expect(FORWARDED_ENV).toEqual(['MOCACTL_SBX_URL', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']);
    for (const name of FORWARDED_ENV) expect(serverOverride()).toContain(`"${name}"`);
    expect(serverOverride()).toContain(
      'env_vars=["MOCACTL_SBX_URL","XDG_CONFIG_HOME","XDG_STATE_HOME"]',
    );
  });

  it('builds the override as TOML that codex -c parses, naming the mcp server it starts', () => {
    // With no id, `mocactl sbx mcp` resolves the binding itself: none is baked in.
    expect(serverOverride()).toMatch(
      /^mcp_servers\.sandbox=\{command="mocactl",args=\["sbx","mcp"\]/,
    );
    expect(serverOverride()).not.toMatch(/--sandbox/);
    expect(serverOverride(SBX)).toContain(`args=["sbx","mcp","--sandbox","${SBX}"]`);
    expect(codexArgs([])).toEqual(['-c', serverOverride(), '--disable', 'shell_tool']);
  });
});
