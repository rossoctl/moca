import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecMachineryError,
  leaseNotice,
  sandboxRules,
  WORKSPACE,
  type LeaseEvent,
} from '@moca/sandbox-client';
import { afterEach, describe, expect, it } from 'vitest';
import { saveAuth } from '../src/config.js';
import { SBX_USAGE, sbxMain, sbxPaths } from '../src/sbx/cli.js';
import { checkAgentConfig } from '../src/sbx/agent-config.js';
import { hasUnpulled, MAX_FILE, repoId } from '../src/sbx/push.js';
import {
  LOGIN,
  NEW,
  NO_LEASE,
  OTHER,
  SBX,
  URL_,
  cleanupTmp,
  git,
  harness,
  leaseEnd,
  repo,
  sandbox,
  withLeaseEvents,
} from './helpers/sbx.js';

afterEach(cleanupTmp);

const binding = (r: string) => JSON.parse(readFileSync(join(r, '.sbx/sandbox.json'), 'utf8'));

describe('mocactl sbx up (SBX0 §6.1)', () => {
  it('creates a sandbox labelled with the repository id, pushes the tree, and binds it', async () => {
    const h = harness();
    expect(await h.run(['up', '--template', 'node22', '--name', 'web'])).toBe(0);
    expect(h.cp.posts()).toHaveLength(1);
    expect(h.cp.posts()[0]!.body).toEqual({
      template: 'node22',
      name: 'web',
      labels: { project: await repoId(h.r) },
    });
    const ws = h.ws.get(NEW).ws;
    expect(readFileSync(join(ws, 'src/app.py'), 'utf8')).toBe('print(1)\n');
    expect(readFileSync(join(ws, 'build/keep.txt'), 'utf8')).toBe('tracked under an ignored dir\n');
    expect(existsSync(join(ws, '.env'))).toBe(false);
    expect(binding(h.r)).toEqual({ id: NEW, controlPlaneUrl: URL_, template: 'node22' });
    expect(readFileSync(join(h.r, '.git/info/exclude'), 'utf8')).toContain('.sbx/');
    expect(git(h.r, 'status', '--porcelain')).not.toContain('.sbx');
    expect(h.io.outs.join('')).toBe(`${NEW}\n`); // stdout: only the id
    expect(h.err()).toMatch(/not pushed, as they may hold secrets .*: \.env, id_rsa/);
    expect(h.err()).toMatch(/pushed 7 files/);
    expect(h.err()).toContain(
      `sandbox ${NEW} (node22), expires ${new Date(1_800_604_800_000).toISOString()}`,
    );
    expect(h.ws.counts()).toEqual({ opened: 1, closed: 1 });
  });

  it('says in its usage that a reused sandbox with unpulled work is left unpushed', () => {
    expect(SBX_USAGE.replace(/\s+/g, ' ')).toContain(
      'a reused sandbox with changes not yet pulled is left unpushed, with a warning, and up exits 0',
    );
  });

  it('uses the default template when none is given (spec §6.1)', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    expect(h.cp.posts()[0]!.body).toMatchObject({ template: 'default' });
    expect(binding(h.r).template).toBe('default');
  });

  it('reuses the bound sandbox when it is ready, and pushes again', async () => {
    const h = harness();
    expect(await h.run(['up', '--template', 'node22'])).toBe(0);
    writeFileSync(join(h.r, 'later.txt'), 'later\n');
    expect(await h.run(['up'])).toBe(0);
    expect(h.cp.posts()).toHaveLength(1);
    expect(h.cp.calls.some((c) => c.method === 'GET' && c.path === `/v1/sandboxes/${NEW}`)).toBe(
      true,
    );
    expect(readFileSync(join(h.ws.get(NEW).ws, 'later.txt'), 'utf8')).toBe('later\n');
  });

  it("reuses the user's newest ready sandbox labelled with this project, never another project's", async () => {
    const r0 = repo();
    const rid = await repoId(r0);
    const h = harness({
      boxes: [
        sandbox({ id: OTHER, labels: { project: 'someone-else' }, createdAt: 1_900_000_000 }),
        sandbox({ id: SBX, labels: { project: rid }, createdAt: 1_800_000_000 }),
      ],
    });
    // The same project: same repository id (no origin, so the root path: use r0 itself).
    expect(await h.run(['up'], { cwd: join(r0, 'src') })).toBe(0);
    expect(h.cp.posts()).toHaveLength(0);
    expect(binding(r0).id).toBe(SBX);
    expect(readFileSync(join(h.ws.get(SBX).ws, 'src/app.py'), 'utf8')).toBe('print(1)\n');
    expect(h.err()).toContain(`reusing ${SBX}`);
  });

  it('gives each worktree of one repository its own sandbox (final review I2)', async () => {
    const h = harness();
    git(h.r, 'remote', 'add', 'origin', 'https://example.invalid/team/app.git');
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-wt-')));
    try {
      const wt = join(base, 'second');
      git(h.r, 'worktree', 'add', '-q', '-b', 'second', wt);
      expect(await h.run(['up'])).toBe(0);
      expect(binding(h.r).id).toBe(NEW);
      expect(await h.run(['up'], { cwd: wt })).toBe(0);
      const posts = h.cp.posts();
      expect(posts).toHaveLength(2); // the second up created its own; it did not reuse the first
      const [p1, p2] = posts.map((p) => (p.body as { labels: { project: string } }).labels.project);
      expect(p1).not.toBe(p2);
      expect(binding(wt).id).not.toBe(NEW);
      expect(h.err()).not.toContain(`reusing ${NEW}`);
      // The first worktree's sandbox kept its tree: the second push went elsewhere.
      expect(existsSync(join(h.ws.get(NEW).ws, 'notes.md'))).toBe(true);
      expect(existsSync(join(h.ws.get(binding(wt).id).ws, 'notes.md'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps using a sandbox bound before the worktree joined the label (migration, final review I2)', async () => {
    // Bound by an older mocactl, whose project label hashed only the origin.
    const h = harness({ boxes: [sandbox({ id: SBX, labels: { project: 'origin-only-hash' } })] });
    mkdirSync(join(h.r, '.sbx'));
    writeFileSync(
      join(h.r, '.sbx/sandbox.json'),
      JSON.stringify({ id: SBX, controlPlaneUrl: URL_ }),
    );
    expect(await h.run(['up'])).toBe(0);
    expect(h.cp.posts()).toHaveLength(0);
    expect(binding(h.r).id).toBe(SBX);
  });

  it('writes the lease rules into CLAUDE.md and AGENTS.md for a lease sandbox (P4-R11)', async () => {
    const h = harness();
    const rid = await repoId(h.r);
    h.cp.boxes.set(
      SBX,
      sandbox({ id: SBX, labels: { project: rid }, mode: 'lease', modeEpoch: 1 }),
    );
    expect(await h.run(['up'])).toBe(0);
    expect(binding(h.r).id).toBe(SBX);
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const md = readFileSync(join(h.r, f), 'utf8');
      expect(md).toContain(sandboxRules(WORKSPACE, 'lease'));
      expect(md).not.toContain('Every tool call runs in a fresh VM');
    }
    // doctor takes the block written for the sandbox's mode.
    expect(checkAgentConfig(h.r)).toEqual([]);
  }, 30_000);

  it('warns and pushes nothing when the reused sandbox holds changes not yet pulled', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const ws = h.ws.get(NEW).ws;
    writeFileSync(join(ws, 'src/app.py'), 'print("agent")\n');
    writeFileSync(join(h.r, 'local.txt'), 'local\n');
    expect(await h.run(['up'])).toBe(0);
    expect(h.err()).toMatch(/changes not yet pulled, so it was left as it is \(not pushed\)/);
    expect(readFileSync(join(ws, 'src/app.py'), 'utf8')).toBe('print("agent")\n'); // survives
    expect(existsSync(join(ws, 'local.txt'))).toBe(false);
  });

  it('creates a new sandbox when the bound one is terminated, saying so', async () => {
    const h = harness({
      boxes: [
        sandbox({ id: SBX, state: 'terminated', reason: 'expired', terminatedAt: 1_800_000_100 }),
      ],
    });
    mkdirSync(join(h.r, '.sbx'));
    writeFileSync(
      join(h.r, '.sbx/sandbox.json'),
      JSON.stringify({ id: SBX, controlPlaneUrl: URL_ }),
    );
    expect(await h.run(['up'])).toBe(0);
    expect(h.err()).toContain(
      `the bound sandbox ${SBX} is terminated (expired); finding or creating another`,
    );
    expect(h.cp.posts()).toHaveLength(1);
    expect(binding(h.r).id).toBe(NEW);
  });

  it('creates a new sandbox when the bound one no longer exists', async () => {
    const h = harness();
    mkdirSync(join(h.r, '.sbx'));
    writeFileSync(join(h.r, '.sbx/sandbox.json'), JSON.stringify({ id: OTHER }));
    expect(await h.run(['up'])).toBe(0);
    expect(h.err()).toContain(`the bound sandbox ${OTHER} no longer exists`);
    expect(binding(h.r).id).toBe(NEW);
  });

  it('refuses to reuse a bound sandbox of another template than --template asks', async () => {
    const h = harness({ boxes: [sandbox({ id: SBX, template: 'python' })] });
    mkdirSync(join(h.r, '.sbx'));
    writeFileSync(join(h.r, '.sbx/sandbox.json'), JSON.stringify({ id: SBX }));
    expect(await h.run(['up', '--template', 'node22'])).toBe(1);
    expect(h.err()).toMatch(/has template python, not node22/);
    expect(h.cp.posts()).toHaveLength(0);
  });

  it('refuses before creating anything: outside a repository, a file over 12 MiB, an IDN URL', async () => {
    const h = harness();
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-norepo-')));
    try {
      expect(await h.run(['up'], { cwd: plain })).toBe(2);
      expect(h.err()).toMatch(/not inside a git repository/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    writeFileSync(join(h.r, 'huge.bin'), Buffer.alloc(MAX_FILE + 1));
    expect(await h.run(['up'])).toBe(1);
    expect(h.err()).toContain(`huge.bin (12.0 MiB, ${MAX_FILE + 1} bytes)`);
    rmSync(join(h.r, 'huge.bin'));
    const idn = 'https://bücher.example.invalid';
    saveAuth(sbxPaths(h.paths), { ...LOGIN, controlPlaneUrl: idn });
    expect(await h.run(['up'], { env: { HOME: h.home, MOCACTL_SBX_URL: idn } })).toBe(1);
    expect(h.err()).toMatch(/xn--bcher-kva\.example\.invalid/);
    expect(h.cp.posts()).toHaveLength(0);
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
  });

  it('refuses flags that are not its own, and --json', async () => {
    const h = harness();
    for (const argv of [
      ['up', '--force'],
      ['up', '--apply'],
      ['up', '-o', 'x'],
      ['up', '--json'],
      ['up', '--sandbox', SBX],
      ['up', 'extra'],
      ['push', '--template', 'x'],
      ['push', '--no-agent-config'],
      ['pull', '--force'],
      ['pull', '--include-secrets'],
      ['ls', '--max-push', '1'],
      ['push', '--max-push', '0'],
      ['push', '--max-push', '1.5'],
      ['up', '--template', ''],
      ['up', '--template', '  '],
      ['create', '--template', ''],
    ]) {
      expect(await h.run(argv), argv.join(' ')).toBe(2);
    }
    expect(h.cp.calls).toHaveLength(0);
  });
});

describe('mocactl sbx push and pull (SBX0 §6.2, §10.3)', () => {
  it('push, pull and up say the lease events their Execs carried (plan-4 M2)', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const queue: LeaseEvent[][] = [];
    const run = (argv: string[]) => {
      h.io.errs.length = 0;
      h.io.outB.length = 0;
      return sbxMain(argv, h.env, h.io, {
        home: h.home,
        fetchImpl: h.cp.fetchImpl,
        cwd: h.r,
        execFactory: withLeaseEvents(h.ws.factory, queue),
      });
    };
    let at = 1_800_000_100_000;
    for (const argv of [['push'], ['pull'], ['up']]) {
      const end = leaseEnd({ reason: 'idle', atUnixMs: (at += 60_000) });
      queue.push([end]);
      expect(await run(argv), argv.join(' ')).toBe(0);
      expect(h.io.errs, argv.join(' ')).toContain(leaseNotice(end, Date.now()));
    }
  });

  it('push is refused while changes are not yet pulled; --force pushes', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const ws = h.ws.get(NEW).ws;
    writeFileSync(join(ws, 'src/app.py'), 'print("agent")\n');
    expect(await h.run(['push'])).toBe(1);
    expect(h.err()).toContain(
      'sbx: the sandbox has changes not yet pulled: run mocactl sbx pull, or push --force to discard them',
    );
    expect(readFileSync(join(ws, 'src/app.py'), 'utf8')).toBe('print("agent")\n');
    expect(await h.run(['push', '--force'])).toBe(0);
    expect(readFileSync(join(ws, 'src/app.py'), 'utf8')).toBe('print(1)\n');
    // The 7 files `up` pushed, and the 7 agent-configuration files it wrote after its push.
    expect(h.err()).toMatch(new RegExp(`pushed 14 files \\(0\\.0 MiB\\) to ${NEW}`));
  });

  it("push is refused over the agent's new file in a source directory named build (review C1)", async () => {
    const h = harness();
    mkdirSync(join(h.r, 'src/main/java/acme/build'), { recursive: true });
    writeFileSync(join(h.r, 'src/main/java/acme/build/Old.java'), 'class Old {}\n');
    git(h.r, 'add', '-f', 'src');
    git(h.r, 'commit', '-qm', 'java');
    expect(await h.run(['up'])).toBe(0);
    const ws = h.ws.get(NEW).ws;
    writeFileSync(join(ws, 'src/main/java/acme/build/New.java'), 'class New {}\n');
    expect(await h.run(['push'])).toBe(1);
    expect(h.err()).toContain('changes not yet pulled');
    expect(readFileSync(join(ws, 'src/main/java/acme/build/New.java'), 'utf8')).toBe(
      'class New {}\n',
    );
  });

  it('push --max-push and --include-secrets', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.r, 'big.bin'), Buffer.alloc(2 << 20));
    expect(await h.run(['push', '--max-push', '1'])).toBe(1);
    expect(h.err()).toMatch(
      /over the 1\.0 MiB limit \(--max-push\); largest: \(top-level files\) 2\.0 MiB/,
    );
    expect(await h.run(['push', '--include-secrets'])).toBe(0);
    expect(readFileSync(join(h.ws.get(NEW).ws, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('pull prints the patch; --apply applies it and advances the baseline; then nothing to pull', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const ws = h.ws.get(NEW).ws;
    writeFileSync(join(ws, 'src/app.py'), 'print(2)\n');
    writeFileSync(join(ws, 'build/keep.txt'), 'agent edit\n');
    expect(await h.run(['pull'])).toBe(0);
    const patch = Buffer.concat(h.io.outB).toString();
    expect(patch).toContain('+print(2)');
    expect(patch).toContain('build/keep.txt');
    expect(readFileSync(join(h.r, 'src/app.py'), 'utf8')).toBe('print(1)\n'); // pull alone changes nothing
    expect(await h.run(['pull', '--apply'])).toBe(0);
    expect(h.io.outB).toEqual([]); // --apply prints no patch
    expect(h.err()).toMatch(/applied the sandbox's changes to 2 files \(\d+ bytes of patch\)/);
    expect(readFileSync(join(h.r, 'src/app.py'), 'utf8')).toBe('print(2)\n');
    expect(readFileSync(join(h.r, 'build/keep.txt'), 'utf8')).toBe('agent edit\n');
    expect(await h.run(['pull'])).toBe(0);
    expect(h.io.outB).toEqual([]);
    expect(h.err()).toBe('nothing to pull');
    // And so a push is no longer refused.
    expect(await h.run(['push'])).toBe(0);
  });

  it('pull -o FILE writes the patch there; pull --sandbox works outside a repository', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'print(2)\n');
    expect(await h.run(['pull', '-o', 'out.patch'], { cwd: join(h.r, 'src') })).toBe(0);
    expect(readFileSync(join(h.r, 'src/out.patch'), 'utf8')).toContain('+print(2)');
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-norepo-')));
    try {
      expect(await h.run(['pull', '--sandbox', NEW], { cwd: plain })).toBe(0);
      expect(Buffer.concat(h.io.outB).toString()).toContain('+print(2)');
      expect(await h.run(['pull', '--apply', '--sandbox', NEW], { cwd: plain })).toBe(2);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('pull --apply over an uncommitted local edit is refused, and the baseline is not advanced', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const { exec } = h.ws.get(NEW);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'print(2)\n');
    writeFileSync(join(h.r, 'src/app.py'), 'print("local")\n');
    expect(await h.run(['pull', '--apply'])).toBe(1);
    expect(h.err()).toMatch(
      /local changes not yet committed \(src\/app\.py\).*; nothing was changed/,
    );
    expect(readFileSync(join(h.r, 'src/app.py'), 'utf8')).toBe('print("local")\n');
    expect(await hasUnpulled(exec)).toBe(true);
  });

  it('refuses a patch over the 8 MiB output cap, applying nothing', async () => {
    const h = harness({ ws: { capBytes: 300 } });
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'x'.repeat(2000));
    expect(await h.run(['pull', '--apply'])).toBe(1);
    expect(h.err()).toMatch(/over 8 MiB as a patch, .*so nothing was pulled/);
    expect(readFileSync(join(h.r, 'src/app.py'), 'utf8')).toBe('print(1)\n');
    expect(await h.run(['pull'])).toBe(1);
    expect(h.io.outB).toEqual([]);
  });

  it('push and pull use the bound sandbox and its control plane, from any subdirectory', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'print(2)\n');
    // No MOCACTL_SBX_URL: the binding's URL is used (R5j), and the root is found from src/.
    expect(await h.run(['pull', '--apply'], { cwd: join(h.r, 'src'), env: { HOME: h.home } })).toBe(
      0,
    );
    expect(readFileSync(join(h.r, 'src/app.py'), 'utf8')).toBe('print(2)\n');
  });

  it('up and push from a subdirectory say the whole work tree is what gets pushed, not just that directory (#611)', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    expect(h.err()).not.toContain('the whole work tree'); // from the root there is nothing to say
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'print(2)\n');
    expect(await h.run(['pull', '--apply'], { cwd: join(h.r, 'src') })).toBe(0);
    expect(await h.run(['push'], { cwd: join(h.r, 'src') })).toBe(0);
    // The count is pinned by the 'pushed 12 files' assertion above; here only the scope is the
    // subject, so the line is matched on the part that does not depend on it.
    expect(h.err()).toMatch(
      /the whole work tree at .* is what gets pushed, not just the current directory/,
    );
    expect(await h.run(['up'], { cwd: join(h.r, 'src') })).toBe(0);
    expect(h.err()).toMatch(
      /the whole work tree at .* is what gets pushed, not just the current directory/,
    );
  });

  it('a terminated sandbox is the control plane answer (exit 1), never a sandbox failure', async () => {
    const h = harness({ boxes: [sandbox({ id: SBX, state: 'terminated', reason: 'deleted' })] });
    expect(await h.run(['push', '--sandbox', SBX])).toBe(1);
    expect(h.err()).toMatch(/sandbox expired/);
  });
});

describe('mocactl sbx up and rm: the agent configuration (SBX0 §6.3, plan Review Focus 3)', () => {
  // In the order `up` reports them. Bob gets both filenames: which one it reads depends on its
  // version (#676).
  const CFG = [
    '.mcp.json',
    '.claude/settings.json',
    'opencode.json',
    '.bob/settings.json',
    '.bob/mcp.json',
    'CLAUDE.md',
    'AGENTS.md',
  ];

  it('up configures Claude Code, OpenCode and IBM Bob after the push, and says so once', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    expect(h.err()).toContain(`configured Claude Code, OpenCode and IBM Bob: ${CFG.join(', ')}`);
    expect(checkAgentConfig(h.r)).toEqual([]);
    // Pushed before it was written: the sandbox's tree is the developer's, not sbx's config.
    expect(existsSync(join(h.ws.get(NEW).ws, '.mcp.json'))).toBe(false);
    expect(h.io.outs.join('')).toBe(`${NEW}\n`);
    expect(await h.run(['up'])).toBe(0);
    expect(h.err()).not.toContain('configured Claude Code');
  });

  // #577: enabledMcpjsonServers does not suppress Claude Code's prompt, whose default declines
  // and leaves the agent with no tools. `up`'s output is the only place that is said in time.
  it('warns that the first claude asks, that the default declines, and where to start it', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const err = h.err();
    expect(err).toContain('"Use this MCP server"');
    expect(err).toContain('the highlighted default declines');
    expect(err).toContain(`start claude in ${h.r}`);
    expect(err).toContain('not a subdirectory');
    // The launcher is the way that asks nothing about the server: named here, where the user is
    // looking (#577). The folder-trust question is the one it cannot take away, and the warning
    // does not promise more than the flags do.
    expect(err).toContain('mocactl sbx claude');
    expect(err).toContain('trust the folder');
    // Said with the configuration it refers to: nothing written, nothing to warn about.
    expect(await h.run(['up'])).toBe(0);
    expect(h.err()).not.toContain('Use this MCP server');
  });

  it('says nothing about the prompt with --no-agent-config, which wires up no server', async () => {
    const h = harness();
    expect(await h.run(['up', '--no-agent-config'])).toBe(0);
    expect(h.err()).not.toContain('Use this MCP server');
  });

  it("keeps the developer's files: other servers, allow entries, CLAUDE.md byte for byte", async () => {
    const h = harness();
    const mcp =
      '{\n  "mcpServers": {\n    "github": { "type": "http", "url": "https://x.example.invalid" }\n  }\n}\n';
    writeFileSync(join(h.r, '.mcp.json'), mcp);
    mkdirSync(join(h.r, '.claude'));
    writeFileSync(
      join(h.r, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['mcp__github__*', 'mcp__x(git status)'] } }),
    );
    const mine = '# Mine\n\nHand-written.\n';
    writeFileSync(join(h.r, 'CLAUDE.md'), mine);
    expect(await h.run(['up'])).toBe(0);
    const m = readFileSync(join(h.r, '.mcp.json'), 'utf8');
    expect(
      m.startsWith(
        '{\n  "mcpServers": {\n    "github": { "type": "http", "url": "https://x.example.invalid" },',
      ),
    ).toBe(true);
    const s = JSON.parse(readFileSync(join(h.r, '.claude/settings.json'), 'utf8'));
    expect(s.permissions.allow).toEqual([
      'mcp__github__*',
      'mcp__x(git status)',
      'mcp__sandbox__*',
    ]);
    expect(
      readFileSync(join(h.r, 'CLAUDE.md'), 'utf8').startsWith(mine + '\n<!-- sbx:begin -->'),
    ).toBe(true);
    expect(await h.run(['rm'])).toBe(0);
    expect(readFileSync(join(h.r, '.mcp.json'), 'utf8')).toBe(mcp);
    expect(readFileSync(join(h.r, 'CLAUDE.md'), 'utf8')).toBe(mine);
  });

  it.each([
    [
      '.mcp.json',
      { mcpServers: { sandbox: { command: 'elsewhere' } } },
      '.mcp.json: mcpServers.sandbox',
    ],
    [
      '.claude/settings.json',
      { permissions: { allow: ['Bash'] } },
      '.claude/settings.json: permissions.allow',
    ],
    ['opencode.json', { tools: { bash: true } }, 'opencode.json: tools.bash'],
  ])(
    'a conflict in %s stops up before anything is created, bound or pushed',
    async (file, body, named) => {
      const h = harness();
      mkdirSync(join(h.r, '.claude'), { recursive: true });
      writeFileSync(join(h.r, file), JSON.stringify(body));
      expect(await h.run(['up'])).toBe(1);
      expect(h.err()).toContain(`sbx: ${named}`);
      expect(h.err()).toContain('--no-agent-config');
      expect(h.cp.calls).toEqual([]);
      expect(h.ws.counts().opened).toBe(0);
      expect(existsSync(join(h.r, '.sbx'))).toBe(false);
      expect(JSON.parse(readFileSync(join(h.r, file), 'utf8'))).toEqual(body);
      for (const f of CFG.filter((f) => f !== file))
        expect(existsSync(join(h.r, f)), f).toBe(false);
      // --no-agent-config: up goes ahead, and leaves the files alone.
      expect(await h.run(['up', '--no-agent-config'])).toBe(0);
      expect(JSON.parse(readFileSync(join(h.r, file), 'utf8'))).toEqual(body);
      for (const f of CFG.filter((f) => f !== file))
        expect(existsSync(join(h.r, f)), f).toBe(false);
    },
  );

  it('a file that is not valid JSON stops up, named, and is never rewritten', async () => {
    const h = harness();
    writeFileSync(join(h.r, '.mcp.json'), '{ "mcpServers": ');
    expect(await h.run(['up'])).toBe(1);
    expect(h.err()).toMatch(/sbx: \.mcp\.json is not valid JSON/);
    expect(readFileSync(join(h.r, '.mcp.json'), 'utf8')).toBe('{ "mcpServers": ');
    expect(h.cp.calls).toEqual([]);
  });

  it('rm of the bound sandbox removes what up added and .sbx/, saying what it removed', async () => {
    const h = harness();
    writeFileSync(join(h.r, 'AGENTS.md'), '# Agents\n');
    const status = git(h.r, 'status', '--porcelain', '--ignored');
    expect(await h.run(['up'])).toBe(0);
    expect(await h.run(['rm'], { cwd: join(h.r, 'src') })).toBe(0);
    expect(h.cp.calls.some((c) => c.method === 'DELETE' && c.path === `/v1/sandboxes/${NEW}`)).toBe(
      true,
    );
    for (const f of [...CFG.filter((f) => f !== 'AGENTS.md'), '.claude', '.sbx']) {
      expect(existsSync(join(h.r, f)), f).toBe(false);
    }
    expect(readFileSync(join(h.r, 'AGENTS.md'), 'utf8')).toBe('# Agents\n');
    expect(h.err()).toMatch(/removed the agent configuration sbx up added: .*AGENTS\.md/);
    expect(h.err()).toContain('removed .sbx/');
    expect(git(h.r, 'status', '--porcelain', '--ignored')).toBe(status);
  });

  const deletes = (h: ReturnType<typeof harness>) =>
    h.cp.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);

  it('rm refuses while the sandbox has changes not yet pulled, deleting nothing (final review I3)', async () => {
    const h = harness({ boxes: [sandbox({ id: OTHER })] });
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'print("agent")\n');
    expect(await h.run(['rm'])).toBe(1);
    expect(h.err()).toContain(
      `sbx: the sandbox has changes not yet pulled, so ${NEW} was not deleted`,
    );
    expect(h.err()).toContain('mocactl sbx pull --apply');
    expect(h.err()).toContain('mocactl sbx rm --force');
    expect(deletes(h)).toEqual([]);
    expect(existsSync(join(h.r, '.sbx/sandbox.json'))).toBe(true);
    expect(checkAgentConfig(h.r)).toEqual([]); // the configuration stays too
    // An explicit id is checked the same way: files with no baseline are work too.
    writeFileSync(join(h.ws.get(OTHER).ws, 'agent-work.txt'), 'x\n');
    expect(await h.run(['rm', OTHER])).toBe(1);
    expect(h.err()).toContain(`so ${OTHER} was not deleted`);
    expect(deletes(h)).toEqual([]);
  });

  it('rm deletes a sandbox with nothing to pull, after checking (final review I3)', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'print(2)\n');
    expect(await h.run(['pull', '--apply'])).toBe(0);
    const opened = h.ws.counts().opened;
    expect(await h.run(['rm'])).toBe(0);
    expect(h.ws.counts().opened).toBe(opened + 1); // it looked
    expect(deletes(h)).toEqual([`/v1/sandboxes/${NEW}`]);
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
  });

  it('rm --force deletes without the check, unpulled work and all (final review I3)', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.ws.get(NEW).ws, 'src/app.py'), 'print("agent")\n');
    const opened = h.ws.counts().opened;
    expect(await h.run(['rm', '--force'])).toBe(0);
    expect(h.ws.counts().opened).toBe(opened); // no Exec at all
    expect(deletes(h)).toEqual([`/v1/sandboxes/${NEW}`]);
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
    expect(await h.run(['rm', '--force', '--keep-config', OTHER])).toBe(1); // still a real 404
  });

  it('rm refuses without --force when the check cannot run, saying why (final review I3)', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    // The Exec path is down: the template's worker is not attached.
    const down = () => ({
      exec: async () => {
        throw new ExecMachineryError(
          'sandbox failure: UNKNOWN: no live worker for sandbox sbx_node22',
        );
      },
      close: () => {},
      ...NO_LEASE,
    });
    const run = (argv: string[]) =>
      sbxMain(argv, h.env, h.io, {
        home: h.home,
        fetchImpl: h.cp.fetchImpl,
        cwd: h.r,
        execFactory: down,
      });
    expect(await run(['rm'])).toBe(1);
    expect(h.err()).toContain(`sbx: cannot check ${NEW} for changes not yet pulled`);
    expect(h.err()).toContain('no live worker for sandbox sbx_node22');
    expect(h.err()).toContain('nothing was deleted');
    expect(h.err()).toContain('mocactl sbx rm --force');
    expect(deletes(h)).toEqual([]);
    expect(existsSync(join(h.r, '.sbx/sandbox.json'))).toBe(true);
    expect(await run(['rm', '--force'])).toBe(0);
    expect(deletes(h)).toEqual([`/v1/sandboxes/${NEW}`]);
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
  });

  it('rm of an expired sandbox needs no --force: no command can reach its files any more', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    h.cp.boxes.set(NEW, sandbox({ id: NEW, state: 'terminated', reason: 'expired' }));
    h.io.errs.length = 0;
    expect(await h.run(['rm'])).toBe(0);
    expect(h.err()).not.toContain('cannot check');
    expect(deletes(h)).toEqual([`/v1/sandboxes/${NEW}`]);
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
  });

  it('rm of a sandbox already deleted needs no --force: there is nothing left to lose', async () => {
    const h = harness({ boxes: [sandbox({ id: OTHER, state: 'terminated', reason: 'deleted' })] });
    expect(await h.run(['rm', OTHER])).toBe(0);
    expect(h.err()).toContain(`deleted ${OTHER}`);
  });

  it('rm keeps the login and unreachable exits when the check cannot reach the control plane', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await sbxMain(['rm'], h.env, h.io, {
      home: h.home,
      fetchImpl: down,
      cwd: h.r,
      execFactory: h.ws.factory,
    });
    expect(r).toBe(4);
    expect(existsSync(join(h.r, '.sbx/sandbox.json'))).toBe(true);
  });

  it('says in its usage that rm refuses while changes are not yet pulled, and takes --force', () => {
    const u = SBX_USAGE.replace(/\s+/g, ' ');
    expect(u).toContain('mocactl sbx rm [ID] [--keep-config] [--force] [--json]');
    expect(u).toContain('refused while the sandbox has changes not yet pulled, unless --force');
  });

  it('rm of a bound sandbox the control plane has purged still takes the config back (review I3)', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    h.cp.boxes.delete(NEW); // past retention: the record is gone, so DELETE answers 404
    // Purged: nothing can reach its workspace, so no check and no --force (final re-review).
    expect(await h.run(['rm'])).toBe(0);
    expect(h.err()).not.toContain('cannot check');
    expect(h.err()).toContain(`${NEW} is already gone`);
    for (const f of [...CFG, '.claude', '.sbx']) expect(existsSync(join(h.r, f)), f).toBe(false);
    // Not the bound sandbox: a 404 is still the failure it was.
    expect(await h.run(['rm', OTHER])).toBe(1);
    expect(h.err()).toMatch(/no such sandbox/);
  });

  it("rm's already-gone applies only on the binding's own control plane (review round 2)", async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const elsewhere = 'https://other-sbx.example.invalid';
    saveAuth(sbxPaths(h.paths), { ...LOGIN, controlPlaneUrl: elsewhere });
    // Every control plane now answers sandbox_not_found for it (the fake ignores the host): on
    // another one, that is a failure, and nothing is removed.
    h.cp.boxes.delete(NEW);
    for (const env of [
      { HOME: h.home, MOCACTL_SBX_URL: elsewhere },
      { HOME: h.home, MOCACTL_SBX_URL: `${elsewhere}/` },
    ]) {
      expect(await h.run(['rm'], { env })).toBe(1);
      expect(h.err()).not.toMatch(/already gone/);
      expect(h.err()).toMatch(/no such sandbox/);
      expect(existsSync(join(h.r, '.sbx/sandbox.json'))).toBe(true);
      expect(checkAgentConfig(h.r)).toEqual([]);
    }
    // The binding's own, spelled with a trailing slash: the same control plane.
    saveAuth(sbxPaths(h.paths), LOGIN);
    expect(
      await h.run(['rm', '--force'], { env: { HOME: h.home, MOCACTL_SBX_URL: `${URL_}/` } }),
    ).toBe(0);
    expect(h.err()).toContain('already gone');
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
  });

  it('rm keeps .sbx/ when the record is unreadable, and says so', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.r, '.sbx/agent-config.json'), '{ broken');
    expect(await h.run(['rm'])).toBe(0);
    expect(h.err()).toMatch(/sbx: \.sbx\/agent-config\.json .*kept/);
    expect(h.err()).toMatch(/kept \.sbx\//);
    expect(existsSync(join(h.r, '.sbx/agent-config.json'))).toBe(true);
    expect(existsSync(join(h.r, '.mcp.json'))).toBe(true);
  });

  it('rm --keep-config, or of another sandbox, leaves the configuration and the binding', async () => {
    const h = harness({ boxes: [sandbox({ id: OTHER })] });
    expect(await h.run(['up'])).toBe(0);
    expect(await h.run(['rm', OTHER])).toBe(0);
    expect(existsSync(join(h.r, '.sbx/sandbox.json'))).toBe(true);
    expect(existsSync(join(h.r, '.mcp.json'))).toBe(true);
    expect(await h.run(['rm', '--keep-config'])).toBe(0);
    expect(existsSync(join(h.r, '.sbx/sandbox.json'))).toBe(true);
    expect(checkAgentConfig(h.r)).toEqual([]);
    expect(h.err()).not.toMatch(/removed/);
    expect(await h.run(['up', '--keep-config'])).toBe(2);
  });

  it('rm takes back a JSONC opencode.json with trailing comments byte for byte (review I1)', async () => {
    const h = harness();
    const oc =
      '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "anthropic/x" // my model\n}\n';
    writeFileSync(join(h.r, 'opencode.json'), oc);
    expect(await h.run(['up'])).toBe(0);
    expect(await h.run(['rm'])).toBe(0);
    expect(readFileSync(join(h.r, 'opencode.json'), 'utf8')).toBe(oc);
    // Again (--force: a deleted sandbox cannot be checked): nothing left to take back, no crash.
    expect(await h.run(['rm', '--force', NEW])).toBe(0);
  });

  it('rm keeps a file up created once the developer has commented in it, and says so (review round 4)', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    const oc = join(h.r, 'opencode.json');
    writeFileSync(oc, '// my notes\n' + readFileSync(oc, 'utf8'));
    expect(await h.run(['rm'])).toBe(0);
    expect(readFileSync(oc, 'utf8')).toBe('// my notes\n{}\n');
    expect(h.err()).toMatch(/^sbx: opencode\.json: kept: sbx up created it/m);
    expect(existsSync(join(h.r, '.mcp.json'))).toBe(false);
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
  });

  it('rm reports a file system error as a message naming the file, not a stack trace', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    // A read-only .claude/: the settings file there cannot be rewritten or deleted.
    chmodSync(join(h.r, '.claude'), 0o500);
    try {
      expect(await h.run(['rm'])).toBe(1);
    } finally {
      chmodSync(join(h.r, '.claude'), 0o700);
    }
    expect(h.err()).toMatch(
      /^sbx: \.claude\/settings\.json: the file could not be (deleted|written) \(EACCES\)/m,
    );
    expect(h.err()).toContain('run mocactl sbx rm again');
    expect(h.err()).not.toMatch(/\n\s+at /); // no stack trace
    expect(existsSync(join(h.r, '.sbx/agent-config.json'))).toBe(true);
    expect(await h.run(['rm'])).toBe(0);
    expect(existsSync(join(h.r, '.claude'))).toBe(false);
  });

  it('rm reports a configuration it cannot take back, keeps the record, and a second rm finishes', async () => {
    const h = harness();
    expect(await h.run(['up'])).toBe(0);
    writeFileSync(join(h.r, 'opencode.json'), '{ broken');
    expect(await h.run(['rm'])).toBe(1);
    expect(h.err()).toMatch(/sbx: opencode\.json is not valid JSON.*run mocactl sbx rm again/);
    expect(existsSync(join(h.r, '.sbx/agent-config.json'))).toBe(true);
    expect(existsSync(join(h.r, '.mcp.json'))).toBe(true);
    writeFileSync(join(h.r, 'opencode.json'), '{}');
    expect(await h.run(['rm'])).toBe(0);
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
    expect(existsSync(join(h.r, '.mcp.json'))).toBe(false);
  });
});
