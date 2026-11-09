import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_DENY } from '../src/sbx/agent-config.js';
import { claudeArgs, serverConfig } from '../src/sbx/claude.js';
import { sbxMain } from '../src/sbx/cli.js';
import { cleanupTmp, fakeCp, repo, SBX, setup, tmp, TOKEN, URL_ } from './helpers/sbx.js';

afterEach(cleanupTmp);

/** The deny `sbx claude` passes: up's list, as one value of the variadic flag (#702). */
const DENY = ['--disallowed-tools', CLAUDE_DENY.join(',')];

/** Puts `root` in Cortex mode, as `sbx up --cortex` records it in .sbx/agent-config.json. */
function cortexRepo(root: string): void {
  mkdirSync(join(root, '.sbx'), { recursive: true });
  writeFileSync(
    join(root, '.sbx', 'agent-config.json'),
    JSON.stringify({ version: 1, cortex: true, files: [], dirs: [], json: [], markdown: [] }),
  );
}

/** A stand-in for the `claude` child: records its argv, then reports an exit code or an error. */
function fakeClaude(outcome: { code?: number; err?: NodeJS.ErrnoException } = { code: 0 }) {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      spawnClaude: (args: string[]) => {
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

describe('mocactl sbx claude (#577)', () => {
  it('registers the sandbox MCP server with --mcp-config, strictly, and writes no config', async () => {
    const { home, env, io } = setup();
    const c = fakeClaude({ code: 0 });
    const code = await sbxMain(['claude', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      claude: c.deps,
    });
    expect(code).toBe(0);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]).toEqual(['--mcp-config', serverConfig(SBX), ...DENY, '--strict-mcp-config']);
    // --sandbox is forwarded to the mcp server claude starts, not dropped.
    expect(c.calls[0]?.[1]).toContain(`"--sandbox","${SBX}"`);
  });

  it("passes the caller's own arguments through, after ours", async () => {
    const { home, env, io } = setup();
    const c = fakeClaude();
    await sbxMain(
      ['claude', '--sandbox', SBX, '--', '--model', 'sonnet', 'fix the test'],
      env,
      io,
      {
        home,
        fetchImpl: mint().fetchImpl,
        claude: c.deps,
      },
    );
    expect(c.calls[0]).toEqual([
      '--mcp-config',
      serverConfig(SBX),
      ...DENY,
      '--strict-mcp-config',
      '--model',
      'sonnet',
      'fix the test',
    ]);
  });

  it("exits with claude's own exit code", async () => {
    const { home, env, io } = setup();
    const c = fakeClaude({ code: 3 });
    const code = await sbxMain(['claude', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      claude: c.deps,
    });
    expect(code).toBe(3);
  });

  it('says how to install Claude Code, and the command to run by hand, when it is not on PATH', async () => {
    const { home, env, io } = setup();
    const err: NodeJS.ErrnoException = new Error('spawn claude ENOENT');
    err.code = 'ENOENT';
    const c = fakeClaude({ err });
    const code = await sbxMain(['claude', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      claude: c.deps,
    });
    expect(code).toBe(1);
    const said = io.errs.join('\n');
    expect(said).toMatch(/claude is not on PATH/);
    expect(said).toMatch(/@anthropic-ai\/claude-code/);
    // The escape hatch is the real command, so it can be copied: the deny included, or running it
    // by hand would hand the agent the laptop again (#702).
    expect(said).toContain(serverConfig(SBX));
    expect(said).toContain(`--disallowed-tools ${CLAUDE_DENY.join(',')} --strict-mcp-config`);
  });

  it('refuses --json: a TUI prints none, and a caller parsing stdout would get the TUI', async () => {
    const { home, env, io } = setup();
    const c = fakeClaude();
    const code = await sbxMain(['claude', '--sandbox', SBX, '--json'], env, io, {
      home,
      claude: c.deps,
    });
    expect(code).toBe(2);
    // The CLI's own NO_JSON guard, before dispatch: claude is never started.
    expect(io.errs.join('\n')).toMatch(/claude has no --json output/);
    expect(c.calls).toEqual([]);
  });

  it('forwards --control-plane-url to the server, which cannot see the flag', async () => {
    const { home, env, io } = setup();
    const c = fakeClaude();
    await sbxMain(['claude', '--sandbox', SBX, '--control-plane-url', URL_], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      claude: c.deps,
    });
    expect(c.calls[0]?.[1]).toContain(`"--control-plane-url","${URL_}"`);
  });

  it('leaves --control-plane-url out when it was not given, so the server resolves it as usual', async () => {
    const { home, env, io } = setup();
    const c = fakeClaude();
    await sbxMain(['claude', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      claude: c.deps,
    });
    expect(c.calls[0]?.[1]).not.toContain('--control-plane-url');
  });

  it('builds the config as the JSON --mcp-config takes, naming the mcp server it starts', () => {
    // With no id, `mocactl sbx mcp` resolves the binding itself: none is baked in.
    expect(JSON.parse(serverConfig())).toEqual({
      mcpServers: { sandbox: { command: 'mocactl', args: ['sbx', 'mcp'] } },
    });
    expect(JSON.parse(serverConfig(SBX)).mcpServers.sandbox?.args).toContain(SBX);
    expect(claudeArgs([])).toEqual([
      '--mcp-config',
      serverConfig(),
      ...DENY,
      '--strict-mcp-config',
    ]);
  });
});

describe("mocactl sbx claude denies Claude Code's local tools (#702)", () => {
  it('denies every built-in up denies, as one value, before the switch that ends the list', () => {
    const args = claudeArgs(['fix the test']);
    const at = args.indexOf('--disallowed-tools');
    expect(at).toBeGreaterThan(0);
    expect(args[at + 1]!.split(',')).toEqual([...CLAUDE_DENY]);
    // --disallowed-tools takes several values: the switch after its one value ends it, so the
    // caller's prompt is a prompt, not one more tool to deny.
    expect(args[at + 2]).toBe('--strict-mcp-config');
    expect(args.at(-1)).toBe('fix the test');
  });

  it('denies them outside a repository, where no settings.json of up can', async () => {
    const { home, env, io } = setup();
    const c = fakeClaude();
    const outside = tmp('sbx-not-a-repo-');
    const code = await sbxMain(['claude', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      cwd: outside,
      claude: c.deps,
    });
    expect(code).toBe(0);
    expect(c.calls[0]).toEqual(expect.arrayContaining(DENY));
  });

  it('denies them in a repository up has not set up', async () => {
    const { home, env, io } = setup();
    const c = fakeClaude();
    await sbxMain(['claude', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      cwd: repo(),
      claude: c.deps,
    });
    expect(c.calls[0]).toEqual(expect.arrayContaining(DENY));
  });

  it('leaves them to Cortex in a repository up --cortex set up, and says so', async () => {
    const { home, env, io } = setup();
    const c = fakeClaude();
    const r = repo();
    cortexRepo(r);
    // From a subdirectory as well: the mode belongs to the repository, as up's binding does.
    const sub = join(r, 'deep', 'er');
    mkdirSync(sub, { recursive: true });
    await sbxMain(['claude', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      cwd: sub,
      claude: c.deps,
    });
    expect(c.calls[0]).toEqual(['--mcp-config', serverConfig(SBX), '--strict-mcp-config']);
    expect(io.errs.join('\n')).toMatch(/Cortex blocks local tools/);
  });

  it('denies them when the Cortex record cannot be read: not knowing is not Cortex mode', async () => {
    const { home, env, io } = setup();
    const c = fakeClaude();
    const r = repo();
    mkdirSync(join(r, '.sbx'), { recursive: true });
    writeFileSync(join(r, '.sbx', 'agent-config.json'), '{ "version": 1, "cortex": true');
    await sbxMain(['claude', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      cwd: r,
      claude: c.deps,
    });
    expect(c.calls[0]).toEqual(expect.arrayContaining(DENY));
    expect(io.errs.join('\n')).not.toMatch(/Cortex/);
  });
});
