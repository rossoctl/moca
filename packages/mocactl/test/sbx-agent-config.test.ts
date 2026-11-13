import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_INSTRUCTIONS } from '@moca/sandbox-client';
import {
  CLAUDE_DENY,
  CLAUDE_MIN_VERSION,
  CLAUDE_RETIRED,
  ConfigConflict,
  MARK_BEGIN,
  MARK_END,
  OPENCODE_OFF,
  RULES,
  checkAgentConfig,
  claudeTooOld,
  removeAgentConfig,
  takeBackAgentConfig,
  writeAgentConfig,
} from '../src/sbx/agent-config.js';
import { sbxDirProblem } from '../src/sbx/state.js';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-cfg-')));
  made.push(d);
  mkdirSync(join(d, '.git'));
  return d;
};
const json = (d: string, f: string) => JSON.parse(readFileSync(join(d, f), 'utf8'));
const text = (d: string, f: string) => readFileSync(join(d, f), 'utf8');
const FILES = [
  '.mcp.json',
  '.claude/settings.json',
  'opencode.json',
  // Bob gets both filenames: which one it reads depends on its version (#676).
  '.bob/settings.json',
  '.bob/mcp.json',
  'CLAUDE.md',
  'AGENTS.md',
];
const conflictOf = (fn: () => unknown): ConfigConflict => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigConflict) return e;
    throw e;
  }
  throw new Error('no ConfigConflict');
};

describe('agent configuration (SBX0 §6.3)', () => {
  it('configures every agent in an empty repository', () => {
    const d = dir();
    expect(writeAgentConfig(d).changed.sort()).toEqual([...FILES].sort());
    expect(json(d, '.mcp.json').mcpServers.sandbox).toEqual({
      command: 'mocactl',
      args: ['sbx', 'mcp'],
    });
    const s = json(d, '.claude/settings.json');
    expect(s.permissions.allow).toEqual(['mcp__sandbox__*']);
    expect(s.permissions.deny).toEqual([...CLAUDE_DENY]);
    // R7: Claude Code loads the project server without asking.
    expect(s.enabledMcpjsonServers).toEqual(['sandbox']);
    const o = json(d, 'opencode.json');
    expect(o.mcp.sandbox).toEqual({
      type: 'local',
      command: ['mocactl', 'sbx', 'mcp'],
      enabled: true,
    });
    for (const t of OPENCODE_OFF) expect(o.tools[t]).toBe(false);
    // IBM Bob reads .bob/settings.json from the repository, so up merges into it as into the
    // others. It has no deny list to write: its local tools stay available (#593's lesson).
    expect(json(d, '.bob/settings.json').mcpServers.sandbox).toEqual({
      command: 'mocactl',
      args: ['sbx', 'mcp'],
    });
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const md = text(d, f);
      expect(md).toBe(`${MARK_BEGIN}\n${RULES}\n${MARK_END}\n`);
      expect(md).toMatch(/fresh VM/);
    }
    expect(checkAgentConfig(d)).toEqual([]);
  });

  it("keeps what the developer has in Bob's settings, and takes back only ours", () => {
    const d = dir();
    mkdirSync(join(d, '.bob'), { recursive: true });
    writeFileSync(
      join(d, '.bob/settings.json'),
      JSON.stringify(
        { mcpServers: { mine: { command: 'x' } }, security: { auth: 'sso' } },
        null,
        2,
      ) + '\n',
    );
    writeAgentConfig(d);
    const b = json(d, '.bob/settings.json');
    expect(b.mcpServers.sandbox).toEqual({ command: 'mocactl', args: ['sbx', 'mcp'] });
    expect(b.mcpServers.mine).toEqual({ command: 'x' });
    expect(b.security).toEqual({ auth: 'sso' });
    expect(checkAgentConfig(d)).toEqual([]);
    // rm leaves the developer's file, minus our entry; it did not create it, so it stays.
    removeAgentConfig(d);
    const after = json(d, '.bob/settings.json');
    expect(after.mcpServers).toEqual({ mine: { command: 'x' } });
    expect(after.security).toEqual({ auth: 'sso' });
  });

  it('deletes the .bob directory it created, when rm leaves nothing in it', () => {
    const d = dir();
    expect(existsSync(join(d, '.bob'))).toBe(false);
    writeAgentConfig(d);
    expect(existsSync(join(d, '.bob/settings.json'))).toBe(true);
    removeAgentConfig(d);
    expect(existsSync(join(d, '.bob/settings.json'))).toBe(false);
    expect(existsSync(join(d, '.bob'))).toBe(false);
  });

  it("doctor reports Bob's missing server, and nothing once up has run", () => {
    const d = dir();
    expect(checkAgentConfig(d)).toContain(
      'IBM Bob: neither .bob/settings.json nor .bob/mcp.json has a sandbox MCP server ' +
        '(mocactl sbx mcp)',
    );
    writeAgentConfig(d);
    expect(checkAgentConfig(d)).toEqual([]);
  });

  // #676: `up` wrote only .bob/settings.json, which Bob 2.0.9 ignores -- it reads .bob/mcp.json --
  // so `up` reported Bob configured while `bob mcp list` said "No MCP servers configured". Both
  // names are written now, and either one alone satisfies doctor: the one that counts is whichever
  // the installed Bob reads, and a developer who configured Bob by hand (`bob mcp add`) has only
  // that one.
  it('writes both of Bob’s filenames, and doctor accepts either alone', () => {
    const d = dir();
    writeAgentConfig(d);
    for (const f of ['.bob/settings.json', '.bob/mcp.json']) {
      expect(json(d, f), f).toEqual({
        mcpServers: { sandbox: { command: 'mocactl', args: ['sbx', 'mcp'] } },
      });
    }
    // Each file on its own is enough; neither is, alone, required.
    for (const drop of ['.bob/settings.json', '.bob/mcp.json']) {
      const one = dir();
      writeAgentConfig(one);
      rmSync(join(one, drop));
      expect(checkAgentConfig(one), `without ${drop}`).toEqual([]);
    }
  });

  // #677 review: checking .bob/mcp.json is new, and it is the file `bob mcp add` writes -- which
  // the guide recommends as the manual fallback. So a repository where the developer ran that by
  // hand must still get through `up`, not stop with a ConfigConflict. Verified against Bob 2.0.9
  // in a fresh repository: `bob mcp add sandbox -- mocactl sbx mcp` writes exactly the two keys
  // below, with no `disabled`/`timeout`/`trust`/`alwaysAllow` field that `isBobServer` would
  // reject. This pins that shape, so a Bob that starts adding keys fails here rather than in a
  // developer's repository.
  it('accepts the entry `bob mcp add` writes by hand, in either file (#677 review)', () => {
    const byHand = { mcpServers: { sandbox: { command: 'mocactl', args: ['sbx', 'mcp'] } } };
    for (const f of ['.bob/mcp.json', '.bob/settings.json']) {
      const d = dir();
      mkdirSync(join(d, '.bob'), { recursive: true });
      writeFileSync(join(d, f), JSON.stringify(byHand, null, 2) + '\n');
      expect(() => writeAgentConfig(d), f).not.toThrow();
      expect(checkAgentConfig(d), f).toEqual([]);
      // The developer's file is left as it was; the other one is created alongside it.
      expect(json(d, f), f).toEqual(byHand);
      const other = f === '.bob/mcp.json' ? '.bob/settings.json' : '.bob/mcp.json';
      expect(json(d, other), other).toEqual(byHand);
    }
  });

  // #677 review: Bob's two filenames carry the same entry, so keeping them in step with a link is
  // a natural thing to do -- and it leaves writeAgentConfig with two Docs over one file. The
  // Markdown loop has always guarded this for CLAUDE.md -> AGENTS.md; the JSON loop had no reason
  // to until Bob got a second filename. Without the guard the name appears twice in what `up`
  // prints and the file is written twice.
  it('writes through a .bob/mcp.json that links to .bob/settings.json, once', () => {
    const d = dir();
    mkdirSync(join(d, '.bob'), { recursive: true });
    writeFileSync(join(d, '.bob/settings.json'), '{}\n');
    symlinkSync('settings.json', join(d, '.bob/mcp.json'));

    const bobNames = writeAgentConfig(d).changed.filter((f) => f.startsWith('.bob/'));
    expect(bobNames).toEqual(['.bob/settings.json']);
    // The link is kept, and both names still read the one merged entry.
    expect(lstatSync(join(d, '.bob/mcp.json')).isSymbolicLink()).toBe(true);
    for (const f of ['.bob/settings.json', '.bob/mcp.json']) {
      expect(json(d, f).mcpServers.sandbox, f).toEqual({
        command: 'mocactl',
        args: ['sbx', 'mcp'],
      });
    }
    expect(checkAgentConfig(d)).toEqual([]);
    // And the take-back leaves the developer's file and its link as they were.
    removeAgentConfig(d);
    expect(json(d, '.bob/settings.json')).toEqual({});
    expect(lstatSync(join(d, '.bob/mcp.json')).isSymbolicLink()).toBe(true);
  });

  it('holds the spec §6.3 lists verbatim', () => {
    expect(CLAUDE_DENY).toEqual([
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Task',
      'EnterWorktree',
      'ExitWorktree',
      'Workflow',
      'Monitor',
      'PowerShell',
      'LSP',
    ]);
    expect(OPENCODE_OFF).toEqual([
      'bash',
      'read',
      'edit',
      'write',
      'patch',
      'glob',
      'grep',
      'list',
      'lsp',
      'webfetch',
      'websearch',
      'task',
      // The newer name for patch in current OpenCode (review round 2).
      'apply_patch',
      'multiedit',
      // Reads the laptop's SKILL.md files into the session (found by running OpenCode 1.18.35).
      'skill',
    ]);
    for (const s of [
      'remote sandbox at `/workspace`',
      'fresh VM',
      'no process survives',
      'persist',
      'no network',
      'one at a time',
      'batch',
    ]) {
      expect(RULES).toContain(s);
    }
  });

  it("writes the MCP server's own instructions, then the GH_TOKEN steering line, as the block (#568)", () => {
    expect(RULES).toBe(
      `## Working in the MOCA sandbox\n\n${MCP_INSTRUCTIONS}\n\n` +
        "GH_TOKEN in the sandbox is a placeholder that the host replaces with the user's token; never set, print or ask for a token.",
    );
  });

  it('names only tools current Claude Code knows: an unknown deny name warns at every start (#568)', () => {
    for (const t of ['MultiEdit', 'LS', 'NotebookRead']) expect(CLAUDE_DENY).not.toContain(t);
  });

  describe('the retired denies a pre-#572 run left behind (#574)', () => {
    /**
     * A repository configured by a mocactl from before #572: the three pre-2.0 tools are in the
     * deny list, and the record says `sbx up` is what put them there. `byHand` go in the list
     * without a record, as the developer's own entries do.
     */
    const pre572 = (d: string, byHand: string[] = []) => {
      mkdirSync(join(d, '.claude'));
      writeFileSync(
        join(d, '.claude/settings.json'),
        '{\n  "permissions": {\n    "deny": []\n  }\n}\n',
      );
      writeAgentConfig(d);
      const s = json(d, '.claude/settings.json');
      s.permissions.deny.push(...CLAUDE_RETIRED, ...byHand);
      writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');
      const rec = json(d, '.sbx/agent-config.json');
      for (const t of CLAUDE_RETIRED) {
        rec.json.push({
          file: '.claude/settings.json',
          op: 'item',
          path: ['permissions', 'deny'],
          value: t,
        });
      }
      writeFileSync(join(d, '.sbx/agent-config.json'), JSON.stringify(rec, null, 2) + '\n');
    };
    const denies = (d: string) => json(d, '.claude/settings.json').permissions.deny as string[];
    const recorded = (d: string) =>
      (json(d, '.sbx/agent-config.json').json as { op: string; value?: unknown }[])
        .filter((r) => r.op === 'item')
        .map((r) => r.value);

    it('names the three #572 dropped, and none of them is a deny to add', () => {
      expect([...CLAUDE_RETIRED]).toEqual(['MultiEdit', 'LS', 'NotebookRead']);
      for (const t of CLAUDE_RETIRED) expect(CLAUDE_DENY).not.toContain(t);
    });

    it('a re-run takes them back and updates the record, leaving the rest of the list alone', () => {
      const d = dir();
      pre572(d);
      expect(denies(d)).toEqual([...CLAUDE_DENY, ...CLAUDE_RETIRED]);
      expect(writeAgentConfig(d).changed).toContain('.claude/settings.json');
      expect(denies(d)).toEqual([...CLAUDE_DENY]);
      for (const t of CLAUDE_RETIRED) expect(recorded(d)).not.toContain(t);
      expect(recorded(d)).toContain('Bash');
      expect(checkAgentConfig(d)).toEqual([]);
      // And a second re-run is a no-op: there is nothing left to take back.
      expect(writeAgentConfig(d).changed).toEqual([]);
    });

    it('keeps one the developer wrote: it is in the list, not in the record', () => {
      const d = dir();
      mkdirSync(join(d, '.claude'));
      writeFileSync(
        join(d, '.claude/settings.json'),
        JSON.stringify({ permissions: { deny: ['MultiEdit', 'LS(src/*)'] } }),
      );
      writeAgentConfig(d);
      writeAgentConfig(d);
      expect(denies(d)).toEqual(['MultiEdit', 'LS(src/*)', ...CLAUDE_DENY]);
      expect(writeAgentConfig(d).changed).toEqual([]);
    });

    it('takes back only the recorded ones when the list holds both', () => {
      const d = dir();
      pre572(d, ['NotebookRead']);
      expect(denies(d)).toEqual([...CLAUDE_DENY, ...CLAUDE_RETIRED, 'NotebookRead']);
      writeAgentConfig(d);
      // One NotebookRead is recorded and goes; the developer's copy stays.
      expect(denies(d)).toEqual([...CLAUDE_DENY, 'NotebookRead']);
    });

    it('drops the record of one already taken back by hand, changing no file', () => {
      const d = dir();
      pre572(d);
      const s = json(d, '.claude/settings.json');
      s.permissions.deny = s.permissions.deny.filter((t: string) => t !== 'LS');
      writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');
      writeAgentConfig(d);
      expect(denies(d)).toEqual([...CLAUDE_DENY]);
      expect(recorded(d).filter((v) => CLAUDE_RETIRED.includes(v as string))).toEqual([]);
    });

    it('a dry run reports the file and takes nothing back', () => {
      const d = dir();
      pre572(d);
      const before = text(d, '.claude/settings.json');
      expect(writeAgentConfig(d, { dryRun: true }).changed).toContain('.claude/settings.json');
      expect(text(d, '.claude/settings.json')).toBe(before);
      expect(recorded(d)).toContain('MultiEdit');
    });

    it('rm after the take-back still restores the file the developer had', () => {
      const d = dir();
      const mine = '{\n  "permissions": {\n    "deny": [\n      "Bash(rm -rf *)"\n    ]\n  }\n}\n';
      mkdirSync(join(d, '.claude'));
      writeFileSync(join(d, '.claude/settings.json'), mine);
      writeAgentConfig(d);
      const s = json(d, '.claude/settings.json');
      s.permissions.deny.push(...CLAUDE_RETIRED);
      writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');
      const rec = json(d, '.sbx/agent-config.json');
      for (const t of CLAUDE_RETIRED) {
        rec.json.push({
          file: '.claude/settings.json',
          op: 'item',
          path: ['permissions', 'deny'],
          value: t,
        });
      }
      writeFileSync(join(d, '.sbx/agent-config.json'), JSON.stringify(rec, null, 2) + '\n');
      writeAgentConfig(d);
      removeAgentConfig(d);
      expect(denies(d)).toEqual(['Bash(rm -rf *)']);
    });
  });

  it('tells a Claude Code older than the deny list covers (#568)', () => {
    expect(CLAUDE_MIN_VERSION).toBe('2.0.0');
    for (const v of ['1.0.128 (Claude Code)', '1.9.99', '0.2.30'])
      expect(claudeTooOld(v), v).toBe(true);
    for (const v of ['2.0.0 (Claude Code)', '2.1.304', '10.0.0', 'garbage', ''])
      expect(claudeTooOld(v), v).toBe(false);
  });

  it('keeps everything the developer had: other servers, allow entries, and their CLAUDE.md byte for byte', () => {
    const d = dir();
    writeFileSync(
      join(d, '.mcp.json'),
      JSON.stringify({
        mcpServers: { github: { type: 'http', url: 'https://x.example.invalid' } },
        other: 1,
      }),
    );
    mkdirSync(join(d, '.claude'));
    writeFileSync(
      join(d, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['mcp__github__*'], deny: ['Bash'] }, model: 'x' }),
    );
    const mine = '# My project\n\nRun `make` to build.\n';
    writeFileSync(join(d, 'CLAUDE.md'), mine);
    writeAgentConfig(d);
    expect(json(d, '.mcp.json')).toMatchObject({
      other: 1,
      mcpServers: { github: { url: 'https://x.example.invalid' } },
    });
    expect(Object.keys(json(d, '.mcp.json'))).toEqual(['mcpServers', 'other']);
    expect(Object.keys(json(d, '.mcp.json').mcpServers)).toEqual(['github', 'sandbox']);
    const s = json(d, '.claude/settings.json');
    expect(s.model).toBe('x');
    expect(Object.keys(s)).toEqual(['permissions', 'model', 'enabledMcpjsonServers']);
    expect(s.permissions.allow).toEqual(['mcp__github__*', 'mcp__sandbox__*']);
    expect(s.permissions.deny.filter((x: string) => x === 'Bash')).toHaveLength(1);
    expect(s.permissions.deny).toEqual(['Bash', ...CLAUDE_DENY.filter((t) => t !== 'Bash')]);
    const md = text(d, 'CLAUDE.md');
    expect(md.startsWith(mine)).toBe(true);
    expect(md.slice(mine.length)).toMatch(new RegExp(`^\\n${MARK_BEGIN}[\\s\\S]*${MARK_END}\\n$`));
  });

  it("keeps the file's own formatting: indentation, comments in opencode.json, line endings", () => {
    const d = dir();
    const mcp =
      '{\n\t"mcpServers": {\n\t\t"github": {\n\t\t\t"url": "https://x.example.invalid"\n\t\t}\n\t}\n}\n';
    writeFileSync(join(d, '.mcp.json'), mcp);
    // OpenCode reads JSONC: comments and trailing commas are kept.
    writeFileSync(
      join(d, 'opencode.json'),
      '{\n    // my model\n    "model": "anthropic/x",\n    "tools": { "bash": false, },\n}\n',
    );
    writeFileSync(join(d, 'AGENTS.md'), '# Agents\r\n\r\nUse care.\r\n');
    writeAgentConfig(d);
    const m = text(d, '.mcp.json');
    expect(m.startsWith('{\n\t"mcpServers": {\n\t\t"github": {\n\t\t\t"url"')).toBe(true);
    expect(m).toContain('\n\t\t"sandbox": {\n\t\t\t"command": "mocactl",');
    const o = text(d, 'opencode.json');
    expect(o).toContain('    // my model\n    "model": "anthropic/x",');
    expect(o).toMatch(/"read": false/);
    const a = text(d, 'AGENTS.md');
    expect(a.startsWith('# Agents\r\n\r\nUse care.\r\n\r\n<!-- sbx:begin -->\r\n')).toBe(true);
    expect(a.endsWith(`${MARK_END}\r\n`)).toBe(true);
    expect(a.replace(/\r\n/g, '')).not.toContain('\n');
    expect(checkAgentConfig(d)).toEqual([]);
    removeAgentConfig(d);
    expect(text(d, '.mcp.json')).toBe(mcp);
    expect(text(d, 'AGENTS.md')).toBe('# Agents\r\n\r\nUse care.\r\n');
    expect(text(d, 'opencode.json')).toContain('// my model');
  });

  it('is idempotent: a second run changes nothing', () => {
    const d = dir();
    writeAgentConfig(d);
    const snap = FILES.map((f) => text(d, f));
    const manifest = text(d, '.sbx/agent-config.json');
    expect(writeAgentConfig(d).changed).toEqual([]);
    expect(writeAgentConfig(d, { dryRun: true }).changed).toEqual([]);
    expect(FILES.map((f) => text(d, f))).toEqual(snap);
    expect(text(d, '.sbx/agent-config.json')).toBe(manifest);
  });

  it('a dry run reports what it would change and writes nothing', () => {
    const d = dir();
    writeFileSync(join(d, 'CLAUDE.md'), '# Mine\n');
    expect(writeAgentConfig(d, { dryRun: true }).changed.sort()).toEqual([...FILES].sort());
    expect(text(d, 'CLAUDE.md')).toBe('# Mine\n');
    for (const f of [...FILES.filter((f) => f !== 'CLAUDE.md'), '.sbx', '.claude']) {
      expect(existsSync(join(d, f)), f).toBe(false);
    }
  });

  it('replaces only the marked block when the rules change, and rm puts the old block back', () => {
    const d = dir();
    const before = `top\n${MARK_BEGIN}\nold rules\n${MARK_END}\nbottom\n`;
    writeFileSync(join(d, 'AGENTS.md'), before);
    writeAgentConfig(d);
    const md = text(d, 'AGENTS.md');
    expect(md.startsWith('top\n')).toBe(true);
    expect(md.endsWith(`${MARK_END}\nbottom\n`)).toBe(true);
    expect(md).not.toContain('old rules');
    removeAgentConfig(d);
    expect(text(d, 'AGENTS.md')).toBe(before);
  });

  it.each([
    [
      '.mcp.json',
      JSON.stringify({ mcpServers: { sandbox: { command: 'other' } } }),
      'mcpServers.sandbox',
    ],
    ['.mcp.json', JSON.stringify({ mcpServers: ['x'] }), 'mcpServers'],
    ['.mcp.json', '[]', '.mcp.json'],
    [
      '.claude/settings.json',
      JSON.stringify({ permissions: { allow: ['Bash'] } }),
      'permissions.allow',
    ],
    [
      '.claude/settings.json',
      JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }),
      'permissions.allow',
    ],
    [
      '.claude/settings.json',
      JSON.stringify({ permissions: { deny: 'Bash' } }),
      'permissions.deny',
    ],
    [
      '.claude/settings.json',
      JSON.stringify({ disabledMcpjsonServers: ['sandbox'] }),
      'disabledMcpjsonServers',
    ],
    [
      '.claude/settings.local.json',
      JSON.stringify({ disabledMcpjsonServers: ['sandbox'] }),
      'disabledMcpjsonServers',
    ],
    // Claude Code reads plain JSON: a comment is refused, not rewritten.
    ['.claude/settings.json', '{ // mine\n "model": "x" }', '.claude/settings.json'],
    ['opencode.json', JSON.stringify({ tools: { bash: true } }), 'tools.bash'],
    ['opencode.json', JSON.stringify({ tools: { lsp: 'yes' } }), 'tools.lsp'],
    [
      'opencode.json',
      JSON.stringify({ mcp: { sandbox: { type: 'remote', url: 'https://x.example.invalid' } } }),
      'mcp.sandbox',
    ],
    [
      'opencode.json',
      JSON.stringify({
        mcp: { sandbox: { type: 'local', command: ['mocactl', 'sbx', 'mcp'], enabled: false } },
      }),
      'mcp.sandbox',
    ],
    ['opencode.json', '{ not json', 'opencode.json'],
    // IBM Bob: a foreign server under our name, and a non-object where mcpServers goes.
    [
      '.bob/settings.json',
      JSON.stringify({ mcpServers: { sandbox: { command: 'other', args: [] } } }),
      'mcpServers.sandbox',
    ],
    ['.bob/settings.json', JSON.stringify({ mcpServers: 7 }), 'mcpServers'],
    ['CLAUDE.md', `a\n${MARK_BEGIN}\nb\n`, 'markers'],
    ['AGENTS.md', `${MARK_BEGIN}\n${MARK_END}\n${MARK_BEGIN}\n${MARK_END}\n`, 'markers'],
  ])('stops on a conflict in %s (%s), naming %s, and writes nothing', (file, body, key) => {
    const d = dir();
    mkdirSync(join(d, '.claude'), { recursive: true });
    if (file.includes('/'))
      mkdirSync(join(d, file.slice(0, file.lastIndexOf('/'))), { recursive: true });
    writeFileSync(join(d, file), body);
    for (const dryRun of [true, false]) {
      const err = conflictOf(() => writeAgentConfig(d, { dryRun }));
      expect(err.file).toBe(file);
      expect(err.message).toContain(file);
      expect(err.message).toContain(key);
      expect(err.message).toMatch(/--no-agent-config/);
    }
    expect(text(d, file)).toBe(body);
    for (const f of FILES.filter((f) => f !== file)) expect(existsSync(join(d, f)), f).toBe(false);
    expect(existsSync(join(d, '.sbx'))).toBe(false);
  });

  // Review I2: OpenCode's agent config overrides the global `tools`, and `permission` is the
  // newer key (tools is deprecated into it); either can switch a local tool back on.
  it.each([
    [{ agent: { build: { tools: { bash: true } } } }, 'agent.build.tools.bash'],
    [{ agent: { plan: { tools: { 'web*': true } } } }, 'agent.plan.tools.web*'],
    [{ permission: { bash: 'allow' } }, 'permission.bash'],
    [{ permission: { read: 'ask' } }, 'permission.read'],
    // `edit` gates write and patch too.
    [{ permission: { edit: { '*': 'deny', 'docs/*': 'allow' } } }, 'permission.edit'],
    [{ permission: { '*': 'ask' } }, 'permission.*'],
    [{ permission: 'allow' }, 'permission'],
    [
      { agent: { build: { permission: { webfetch: 'allow' } } } },
      'agent.build.permission.webfetch',
    ],
    [{ agent: { build: { permission: 'ask' } } }, 'agent.build.permission'],
  ])('refuses an OpenCode override that re-enables a local tool: %j names %s', (body, key) => {
    const d = dir();
    writeFileSync(join(d, 'opencode.json'), JSON.stringify(body));
    const err = conflictOf(() => writeAgentConfig(d, { dryRun: true }));
    expect(err.file).toBe('opencode.json');
    expect(err.key).toBe(key);
    expect(err.message).toContain(`opencode.json: ${key}`);
  });

  it.each(['{ }\n', '{\n}\n', '{\n  "tools": { }\n}\n', '{\n  "mcp": {\n  }\n}\n'])(
    'an empty object keeps its inside through up and rm (review round 2): %j',
    (oc) => {
      const d = dir();
      writeFileSync(join(d, 'opencode.json'), oc);
      mkdirSync(join(d, '.claude'));
      writeFileSync(join(d, '.claude/settings.json'), '{\n  "permissions": {\n  }\n}\n');
      writeAgentConfig(d);
      expect(checkAgentConfig(d)).toEqual([]);
      removeAgentConfig(d);
      expect(text(d, 'opencode.json')).toBe(oc);
      expect(text(d, '.claude/settings.json')).toBe('{\n  "permissions": {\n  }\n}\n');
    },
  );

  it.each([
    '{"model": "x" /* a\n  b */}',
    '{\n  "model": "x" /* c */ }\n',
    '{"tools":{"todowrite":true /* a\n b */ }}',
    '{ "todowrite": true /* a\n */ }',
    '{\n  "tools": {\n    "todowrite": true /* a\n    b */ }\n}\n',
  ])('keeps a comment before a closing bracket, through up and rm (review round 3): %j', (oc) => {
    const d = dir();
    writeFileSync(join(d, 'opencode.json'), oc);
    writeAgentConfig(d);
    expect(checkAgentConfig(d)).toEqual([]);
    removeAgentConfig(d);
    expect(text(d, 'opencode.json')).toBe(oc);
  });

  it('puts new members after a multi-line block comment, not inside it (review round 2)', () => {
    const d = dir();
    const oc = '{\n  "model": "x" /* a\n  b */\n}\n';
    writeFileSync(join(d, 'opencode.json'), oc);
    writeAgentConfig(d);
    expect(checkAgentConfig(d)).toEqual([]);
    expect(text(d, 'opencode.json').startsWith('{\n  "model": "x", /* a\n  b */\n')).toBe(true);
    removeAgentConfig(d);
    expect(text(d, 'opencode.json')).toBe(oc);
  });

  it.each([
    [{ tools: { apply_patch: true } }, 'tools.apply_patch'],
    [{ agent: { build: { tools: { apply_patch: true } } } }, 'agent.build.tools.apply_patch'],
    [{ permission: { apply_patch: 'allow' } }, 'permission.apply_patch'],
    // skill reads the laptop's SKILL.md files into the session: off like the local tools.
    [{ tools: { skill: true } }, 'tools.skill'],
    [{ permission: { skill: 'allow' } }, 'permission.skill'],
  ])('refuses a local tool switched on: %j names %s', (body, key) => {
    const d = dir();
    writeFileSync(join(d, 'opencode.json'), JSON.stringify(body));
    expect(conflictOf(() => writeAgentConfig(d, { dryRun: true })).key).toBe(key);
    // And doctor finds it in a configured repository.
    const e = dir();
    writeAgentConfig(e);
    const o = json(e, 'opencode.json');
    Object.assign(o, body);
    if ('tools' in body) o.tools = { ...o.tools, ...body.tools };
    writeFileSync(join(e, 'opencode.json'), JSON.stringify(o));
    expect(checkAgentConfig(e).join('\n')).toMatch(new RegExp(`OpenCode.*${key.split('.').pop()}`));
  });

  it('accepts OpenCode overrides that keep the local tools off', () => {
    const d = dir();
    const body = {
      permission: {
        bash: 'deny',
        edit: { '*': 'deny' },
        todowrite: 'allow',
        sandbox_bash: 'allow',
      },
      agent: {
        build: { tools: { bash: false, mymcp_x: true }, permission: { question: 'allow' } },
      },
    };
    writeFileSync(join(d, 'opencode.json'), JSON.stringify(body));
    writeAgentConfig(d);
    expect(checkAgentConfig(d)).toEqual([]);
  });

  it.each([
    [
      '.mcp.json',
      '{"mcpServers":{"sandbox":{"command":"evil"},"sandbox":{"command":"mocactl","args":["sbx","mcp"]}}}',
      'mcpServers.sandbox',
      /duplicate key/,
    ],
    [
      '.mcp.json',
      '{\n  "mcpServers": {"a": {"command":"a"}},\n  "mcpServers": {}\n}\n',
      'mcpServers',
      /duplicate key/,
    ],
    [
      'opencode.json',
      '{\n  "tools": {"bash": true},\n  // again\n  "tools": {"read": false}\n}\n',
      'tools',
      /duplicate key/,
    ],
    ['.mcp.json', '\ufeff{"mcpServers":{}}\n', '.mcp.json', /starts with a byte-order mark/],
    ['opencode.json', '\ufeff{}', 'opencode.json', /starts with a byte-order mark/],
    ['.mcp.json', '', '.mcp.json', /is empty/],
    ['.mcp.json', '  \n', '.mcp.json', /is empty/],
    ['.mcp.json', '{"a":1,}', '.mcp.json', /is not valid JSON/],
  ])('refuses %s %j, naming %s and saying why', (file, body, key, why) => {
    const d = dir();
    writeFileSync(join(d, file), body);
    const err = conflictOf(() => writeAgentConfig(d, { dryRun: true }));
    expect(err.file).toBe(file);
    expect(err.key).toBe(key);
    expect(err.message).toMatch(why);
    expect(err.message).not.toMatch(/reads no comments/);
    expect(checkAgentConfig(d).join('\n')).toMatch(why);
  });

  it('says a comment is why Claude Code would refuse its file', () => {
    const d = dir();
    writeFileSync(join(d, '.mcp.json'), '{ // mine\n}');
    expect(conflictOf(() => writeAgentConfig(d)).message).toMatch(
      /comments, which Claude Code does not read/,
    );
  });

  it('accepts a sandbox server that is already the same one, and never removes it', () => {
    const d = dir();
    const mine = {
      mcpServers: { sandbox: { type: 'stdio', command: 'mocactl', args: ['sbx', 'mcp'], env: {} } },
    };
    writeFileSync(join(d, '.mcp.json'), JSON.stringify(mine, null, 2) + '\n');
    writeAgentConfig(d);
    expect(json(d, '.mcp.json')).toEqual(mine);
    expect(checkAgentConfig(d)).toEqual([]);
    removeAgentConfig(d);
    expect(json(d, '.mcp.json')).toEqual(mine);
  });

  it('removes exactly what it added, and deletes the files it created', () => {
    const d = dir();
    mkdirSync(join(d, '.claude'));
    writeFileSync(
      join(d, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['mcp__github__*'], deny: ['Bash'] } }),
    );
    writeFileSync(join(d, 'CLAUDE.md'), '# Mine\n');
    writeAgentConfig(d);
    expect(removeAgentConfig(d).sort()).toEqual([...FILES].sort());
    expect(json(d, '.claude/settings.json')).toEqual({
      permissions: { allow: ['mcp__github__*'], deny: ['Bash'] },
    });
    expect(text(d, 'CLAUDE.md')).toBe('# Mine\n');
    for (const f of ['.mcp.json', 'opencode.json', 'AGENTS.md']) {
      expect(existsSync(join(d, f)), f).toBe(false);
    }
    expect(existsSync(join(d, '.sbx/agent-config.json'))).toBe(false);
    expect(removeAgentConfig(d)).toEqual([]);
  });

  // Review round 4: a file sbx up created is deleted only when nothing the developer wrote is in it.
  it.each([
    ['a header comment', (t: string) => '// my notes\n' + t, '// my notes\n{}\n'],
    [
      'a comment line inside',
      (t: string) => t.replace(/\n}\n$/, '\n  /* later */\n}\n'),
      '{\n  /* later */\n}\n',
    ],
  ])(
    'keeps a file it created that now holds %s, writing back the rest and saying so',
    (_n, edit, left) => {
      const d = dir();
      writeAgentConfig(d);
      writeFileSync(join(d, 'opencode.json'), edit(text(d, 'opencode.json')));
      const r = takeBackAgentConfig(d);
      expect(text(d, 'opencode.json')).toBe(left);
      expect(r.removed).toContain('opencode.json');
      expect(r.warnings.join('\n')).toMatch(/opencode\.json: kept: sbx up created it, but/);
      expect(existsSync(join(d, '.mcp.json'))).toBe(false);
      expect(existsSync(join(d, '.sbx/agent-config.json'))).toBe(false);
    },
  );

  it('still deletes a file it created when only whitespace was added to it', () => {
    const d = dir();
    writeAgentConfig(d);
    writeFileSync(join(d, 'opencode.json'), '\n' + text(d, 'opencode.json') + '\n\n');
    const r = takeBackAgentConfig(d);
    expect(existsSync(join(d, 'opencode.json'))).toBe(false);
    expect(r.removed).toContain('opencode.json');
    expect(r.warnings).toEqual([]);
  });

  // Review round 4 (probe14): blank lines the developer put between two of ours, and a key of
  // theirs after ours on its line, come through rm.
  it('keeps blank lines added between its members, and a key added after one on its line', () => {
    const d = dir();
    writeFileSync(join(d, 'opencode.json'), '{\n  "model": "x"\n}\n');
    writeAgentConfig(d);
    const mid = text(d, 'opencode.json')
      .replace('  },\n  "tools": {', '  },\n\n\n  "tools": {')
      .replace(/  }\n}\n$/, '  }, "theme": "y"\n}\n');
    writeFileSync(join(d, 'opencode.json'), mid);
    takeBackAgentConfig(d);
    // What up wrote is gone; the blank lines and ` "theme": "y"` are the developer's, kept.
    expect(text(d, 'opencode.json')).toBe('{\n  "model": "x",\n\n "theme": "y"\n}\n');
  });

  it('removes the .claude directory it created, and enabledMcpjsonServers with it', () => {
    const d = dir();
    writeAgentConfig(d);
    removeAgentConfig(d);
    for (const f of [...FILES, '.claude']) expect(existsSync(join(d, f)), f).toBe(false);
  });

  it('removal keeps what the developer added after sbx up, and the values they had', () => {
    const d = dir();
    writeFileSync(join(d, 'settings.json'), ''); // a decoy at the root: never touched
    mkdirSync(join(d, '.claude'));
    writeFileSync(
      join(d, '.claude/settings.json'),
      JSON.stringify({ enabledMcpjsonServers: ['github'] }),
    );
    writeAgentConfig(d);
    const s = json(d, '.claude/settings.json');
    expect(s.enabledMcpjsonServers).toEqual(['github', 'sandbox']);
    s.permissions.allow.push('mcp__later__*');
    s.later = true;
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2));
    const m = json(d, '.mcp.json');
    m.mcpServers.later = { command: 'later' };
    writeFileSync(join(d, '.mcp.json'), JSON.stringify(m, null, 2));
    removeAgentConfig(d);
    expect(json(d, '.claude/settings.json')).toEqual({
      enabledMcpjsonServers: ['github'],
      permissions: { allow: ['mcp__later__*'] },
      later: true,
    });
    expect(json(d, '.mcp.json')).toEqual({ mcpServers: { later: { command: 'later' } } });
    expect(text(d, 'settings.json')).toBe('');
  });

  it('writes atomically and keeps the file mode', () => {
    const d = dir();
    writeFileSync(join(d, '.mcp.json'), '{}\n');
    chmodSync(join(d, '.mcp.json'), 0o600);
    writeFileSync(join(d, 'CLAUDE.md'), '# x\n');
    chmodSync(join(d, 'CLAUDE.md'), 0o640);
    writeAgentConfig(d);
    expect(statSync(join(d, '.mcp.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, 'CLAUDE.md')).mode & 0o777).toBe(0o640);
    expect(statSync(join(d, '.sbx/agent-config.json')).mode & 0o777).toBe(0o600);
    removeAgentConfig(d);
    expect(statSync(join(d, '.mcp.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, 'CLAUDE.md')).mode & 0o777).toBe(0o640);
  });

  it('writes through a CLAUDE.md that links to AGENTS.md, once, and keeps the link', () => {
    const d = dir();
    writeFileSync(join(d, 'AGENTS.md'), '# Shared\n');
    symlinkSync('AGENTS.md', join(d, 'CLAUDE.md'));
    expect(writeAgentConfig(d).changed.filter((f) => f.endsWith('.md'))).toEqual(['AGENTS.md']);
    const md = text(d, 'AGENTS.md');
    expect(md.split(MARK_BEGIN)).toHaveLength(2);
    expect(md.startsWith('# Shared\n\n')).toBe(true);
    expect(statSync(join(d, 'CLAUDE.md')).isFile()).toBe(true);
    expect(readFileSync(join(d, 'CLAUDE.md'), 'utf8')).toBe(md);
    expect(checkAgentConfig(d)).toEqual([]);
    removeAgentConfig(d);
    expect(text(d, 'AGENTS.md')).toBe('# Shared\n');
    expect(realpathSync(join(d, 'CLAUDE.md'))).toBe(join(d, 'AGENTS.md'));
  });

  it('takes back a .mcp.json that links to a file inside the repository (review round 4)', () => {
    const d = dir();
    mkdirSync(join(d, 'config'));
    writeFileSync(join(d, 'config/mcp.json'), '{\n  "mcpServers": {}\n}\n');
    symlinkSync('config/mcp.json', join(d, '.mcp.json'));
    writeAgentConfig(d);
    expect(
      json(d, '.sbx/agent-config.json').json.some(
        (r: { file: string }) => r.file === 'config/mcp.json',
      ),
    ).toBe(true);
    const r = takeBackAgentConfig(d);
    expect(r.recordKept).toBe(false);
    expect(text(d, 'config/mcp.json')).toBe('{\n  "mcpServers": {}\n}\n');
  });

  it('takes back an opencode.json that links to a commented file (final-review fix)', () => {
    // The record names the link's target; JSONC is decided by what was written, not that name.
    const d = dir();
    mkdirSync(join(d, 'config'));
    const original = '// shared\n{\n  "model": "x"\n}\n';
    writeFileSync(join(d, 'config/oc.json'), original);
    symlinkSync('config/oc.json', join(d, 'opencode.json'));
    writeAgentConfig(d);
    const r = takeBackAgentConfig(d);
    expect(r.recordKept).toBe(false);
    expect(text(d, 'config/oc.json')).toBe(original);
  });

  it('refuses a file that links outside the repository', () => {
    const d = dir();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-out-')));
    made.push(outside);
    writeFileSync(join(outside, 'CLAUDE.md'), '# dotfiles\n');
    symlinkSync(join(outside, 'CLAUDE.md'), join(d, 'CLAUDE.md'));
    const err = conflictOf(() => writeAgentConfig(d));
    expect(err.file).toBe('CLAUDE.md');
    expect(err.message).toMatch(/outside the repository/);
    expect(text(outside, 'CLAUDE.md')).toBe('# dotfiles\n');
  });

  it('uses opencode.jsonc when that is the file the repository has; refuses both', () => {
    const d = dir();
    writeFileSync(join(d, 'opencode.jsonc'), '{\n  // mine\n  "model": "x"\n}\n');
    writeAgentConfig(d);
    expect(existsSync(join(d, 'opencode.json'))).toBe(false);
    expect(text(d, 'opencode.jsonc')).toContain('"sandbox"');
    expect(checkAgentConfig(d)).toEqual([]);
    removeAgentConfig(d);
    expect(text(d, 'opencode.jsonc')).toBe('{\n  // mine\n  "model": "x"\n}\n');
    writeFileSync(join(d, 'opencode.json'), '{}');
    const err = conflictOf(() => writeAgentConfig(d, { dryRun: true }));
    expect(err.message).toMatch(/opencode\.json.*opencode\.jsonc|opencode\.jsonc.*opencode\.json/);
  });

  it('a later run records only what it added: rm still takes back the first run too', () => {
    const d = dir();
    writeAgentConfig(d);
    const s = json(d, '.claude/settings.json');
    s.permissions.deny = s.permissions.deny.filter((t: string) => t !== 'Grep');
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));
    expect(writeAgentConfig(d).changed).toEqual(['.claude/settings.json']);
    removeAgentConfig(d);
    for (const f of [...FILES, '.claude']) expect(existsSync(join(d, f)), f).toBe(false);
  });

  it.each([
    ['corrupt', '{ broken'],
    ['of an unknown version', JSON.stringify({ version: 2, files: [] })],
    // Review round 3: every entry's shape is checked.
    ['missing a list', JSON.stringify({ version: 1, files: [], dirs: [], json: [] })],
    [
      'with a list that is not one',
      JSON.stringify({ version: 1, files: {}, dirs: [], json: [], markdown: [] }),
    ],
    [
      'with a file that is not a string',
      JSON.stringify({ version: 1, files: [1], dirs: [], json: [], markdown: [] }),
    ],
    [
      'with an inner that is not whitespace',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'inner', path: ['mcp'], inner: ' /* injected */ ' }],
        markdown: [],
      }),
    ],
    [
      'with an inner that is not a string',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'inner', path: ['mcp'], inner: 7 }],
        markdown: [],
      }),
    ],
    [
      'with an unknown op',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'drop', path: [] }],
        markdown: [],
      }),
    ],
    [
      'with a path that is not a list of keys',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'key', path: 'mcp', value: 1 }],
        markdown: [],
      }),
    ],
    // Review round 4: a path names at least one key.
    [
      'with an empty path',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'key', path: [], value: 1 }],
        markdown: [],
      }),
    ],
    [
      'with a container of an empty path',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'container', path: [] }],
        markdown: [],
      }),
    ],
    [
      'with a key and no value',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'opencode.json', op: 'key', path: ['mcp'] }],
        markdown: [],
      }),
    ],
    [
      'with a Markdown entry of an unknown mode',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [],
        markdown: [{ file: 'CLAUDE.md', mode: 'moved' }],
      }),
    ],
    [
      'with a replaced entry and no previous block',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [],
        markdown: [{ file: 'CLAUDE.md', mode: 'replaced' }],
      }),
    ],
    [
      'with a file outside the repository',
      JSON.stringify({ version: 1, files: ['../x.json'], dirs: [], json: [], markdown: [] }),
    ],
    // Review round 4: a record names only the files sbx up writes.
    [
      'with a JSON entry for a file sbx up never writes',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'package.json', op: 'container', path: ['scripts'] }],
        markdown: [],
      }),
    ],
    [
      'with a created file sbx up never writes',
      JSON.stringify({ version: 1, files: ['package.json'], dirs: [], json: [], markdown: [] }),
    ],
    [
      'with a Markdown entry for a file sbx up never writes',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [],
        markdown: [{ file: 'README.md', mode: 'created' }],
      }),
    ],
    [
      'with a JSON entry for a Markdown file',
      JSON.stringify({
        version: 1,
        files: [],
        dirs: [],
        json: [{ file: 'CLAUDE.md', op: 'container', path: ['x'] }],
        markdown: [],
      }),
    ],
    [
      'with a directory sbx up never creates',
      JSON.stringify({ version: 1, files: [], dirs: ['src'], json: [], markdown: [] }),
    ],
  ])('a record that is %s is kept, with a warning, and nothing is removed', (_n, body) => {
    const d = dir();
    writeAgentConfig(d);
    writeFileSync(join(d, '.sbx/agent-config.json'), body);
    const r = takeBackAgentConfig(d);
    expect(r.removed).toEqual([]);
    expect(r.recordKept).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/\.sbx\/agent-config\.json .*kept/);
    expect(text(d, '.sbx/agent-config.json')).toBe(body);
    expect(existsSync(join(d, '.mcp.json'))).toBe(true);
    // And up will not write over it, orphaning what it lists.
    expect(conflictOf(() => writeAgentConfig(d, { dryRun: true })).file).toBe(
      '.sbx/agent-config.json',
    );
  });

  it('names a Markdown file whose markers were broken by hand as skipped, leaving it alone', () => {
    const d = dir();
    writeFileSync(join(d, 'CLAUDE.md'), '# Mine\n');
    writeAgentConfig(d);
    const broken = text(d, 'CLAUDE.md').replace(MARK_END, '');
    writeFileSync(join(d, 'CLAUDE.md'), broken);
    const r = takeBackAgentConfig(d);
    expect(text(d, 'CLAUDE.md')).toBe(broken);
    expect(r.removed).not.toContain('CLAUDE.md');
    expect(r.warnings.join('\n')).toMatch(/CLAUDE\.md: skipped: .*markers/);
    expect(existsSync(join(d, 'AGENTS.md'))).toBe(false);
  });

  it('refuses to remove the block from a Markdown file now linked outside the repository', () => {
    const d = dir();
    writeAgentConfig(d);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-out-')));
    made.push(outside);
    writeFileSync(join(outside, 'AGENTS.md'), text(d, 'AGENTS.md'));
    rmSync(join(d, 'AGENTS.md'));
    symlinkSync(join(outside, 'AGENTS.md'), join(d, 'AGENTS.md'));
    const before = text(outside, 'AGENTS.md');
    const err = conflictOf(() => removeAgentConfig(d));
    expect(err.file).toBe('AGENTS.md');
    expect(err.message).toMatch(/outside the repository/);
    expect(text(outside, 'AGENTS.md')).toBe(before);
    expect(existsSync(join(d, '.mcp.json'))).toBe(true); // nothing removed
  });

  it('refuses to remove from a file that is no longer valid JSON, changing nothing', () => {
    const d = dir();
    writeAgentConfig(d);
    writeFileSync(join(d, 'opencode.json'), '{ broken');
    const err = conflictOf(() => removeAgentConfig(d));
    expect(err.file).toBe('opencode.json');
    expect(existsSync(join(d, '.mcp.json'))).toBe(true);
    expect(existsSync(join(d, '.sbx/agent-config.json'))).toBe(true);
  });

  it('reports a built-in tool that is enabled again, and a missing server', () => {
    const d = dir();
    writeAgentConfig(d);
    const s = json(d, '.claude/settings.json');
    s.permissions.deny = s.permissions.deny.filter((t: string) => t !== 'Bash');
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));
    const o = json(d, 'opencode.json');
    delete o.mcp.sandbox;
    writeFileSync(join(d, 'opencode.json'), JSON.stringify(o));
    const problems = checkAgentConfig(d);
    expect(problems.join('\n')).toMatch(/Claude Code.*Bash/);
    expect(problems.join('\n')).toMatch(/OpenCode.*sandbox MCP server/);
  });

  it.each([
    [
      'an allow entry for a built-in',
      (d: string) => {
        const s = json(d, '.claude/settings.json');
        s.permissions.allow.push('Read');
        writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));
      },
      /Claude Code.*allow.*Read/,
    ],
    [
      'an OpenCode tool switched on',
      (d: string) => {
        const o = json(d, 'opencode.json');
        o.tools.webfetch = true;
        writeFileSync(join(d, 'opencode.json'), JSON.stringify(o));
      },
      /OpenCode.*webfetch/,
    ],
    [
      'the server no longer pre-approved',
      (d: string) => {
        const s = json(d, '.claude/settings.json');
        delete s.enabledMcpjsonServers;
        writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));
      },
      /Claude Code.*enabledMcpjsonServers/,
    ],
    [
      'the server rejected in settings.local.json',
      (d: string) =>
        writeFileSync(
          join(d, '.claude/settings.local.json'),
          JSON.stringify({ disabledMcpjsonServers: ['sandbox'] }),
        ),
      /Claude Code.*settings\.local\.json.*disabledMcpjsonServers/,
    ],
    [
      'the server rejected in settings.json',
      (d: string) => {
        const s = json(d, '.claude/settings.json');
        s.disabledMcpjsonServers = ['sandbox'];
        writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));
      },
      /settings\.json disabledMcpjsonServers.*remove sandbox from disabledMcpjsonServers/,
    ],
    [
      'the rules block removed',
      (d: string) => writeFileSync(join(d, 'AGENTS.md'), '# none\n'),
      /AGENTS\.md/,
    ],
    [
      'a file broken by hand',
      (d: string) => writeFileSync(join(d, '.mcp.json'), '{'),
      /\.mcp\.json.*not valid JSON/,
    ],
    [
      'an OpenCode agent that switches a tool back on',
      (d: string) => {
        const o = json(d, 'opencode.json');
        o.agent = { build: { tools: { bash: true } } };
        o.permission = { edit: 'allow' };
        writeFileSync(join(d, 'opencode.json'), JSON.stringify(o));
      },
      /OpenCode: opencode\.json re-enables local built-in tools: agent\.build\.tools\.bash, permission\.edit/,
    ],
    [
      'no configuration at all',
      (d: string) => {
        for (const f of FILES) rmSync(join(d, f));
      },
      /Claude Code[\s\S]*OpenCode/,
    ],
  ])('doctor finds %s', (_what, spoil, re) => {
    const d = dir();
    writeAgentConfig(d);
    spoil(d);
    expect(checkAgentConfig(d).join('\n')).toMatch(re);
  });

  // #577: the toolless state `up` refuses to create, which a user reaches by pressing Enter at
  // Claude Code's prompt. `up` cannot undo it (it never writes settings.local.json, and
  // writeAgentConfig refuses to merge over the rejection), so doctor must carry the recovery.
  it('names deleting settings.local.json, the one fix for the toolless state', () => {
    const d = dir();
    writeAgentConfig(d);
    writeFileSync(
      join(d, '.claude/settings.local.json'),
      JSON.stringify({ disabledMcpjsonServers: ['sandbox'] }),
    );
    const found = checkAgentConfig(d).filter((p) => p.includes('settings.local.json'));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('delete .claude/settings.local.json');
    expect(found[0]).toContain('Use this MCP server');
    // The launcher loads the server without asking, so it works in this state too (#577).
    expect(found[0]).toContain('mocactl sbx claude');
    // The consequence, so the line reads as a problem and not as a note about a key.
    expect(found[0]).toMatch(/neither the sandbox's tools nor its own/);
    // And `up` is still refused, so the fix doctor names is the only one there is.
    expect(conflictOf(() => writeAgentConfig(d)).message).toMatch(/disabledMcpjsonServers/);
  });
});

describe('an untrusted .sbx/ (#554 review)', () => {
  it('refuses a symlinked .sbx: nothing is written outside the repository, nothing taken back', () => {
    const d = dir();
    const outside = dir();
    symlinkSync(outside, join(d, '.sbx'));
    expect(conflictOf(() => writeAgentConfig(d)).message).toMatch(/^\.sbx is a symlink/);
    expect(existsSync(join(outside, 'agent-config.json'))).toBe(false);
    expect(existsSync(join(d, '.mcp.json'))).toBe(false);
    const t = takeBackAgentConfig(d);
    expect(t.removed).toEqual([]);
    expect(t.recordKept).toBe(true);
    expect(t.warnings.join('\n')).toMatch(/\.sbx is a symlink/);
  });

  it("refuses a .sbx/ tracked by git, whose record is the repository's say-so", () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-cfg-')));
    made.push(d);
    execFileSync('git', ['init', '-q', d]);
    mkdirSync(join(d, '.sbx'));
    writeFileSync(
      join(d, '.sbx', 'agent-config.json'),
      '{"version":1,"files":[],"dirs":[],"json":[],"markdown":[]}\n',
    );
    execFileSync('git', ['add', '.sbx'], { cwd: d });
    expect(conflictOf(() => writeAgentConfig(d)).message).toMatch(/^\.sbx is tracked by git/);
    expect(takeBackAgentConfig(d).warnings.join('\n')).toMatch(/tracked by git/);
  });

  it('refuses a tracked .SBX/, which a case-insensitive filesystem opens as .sbx/', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-cfg-')));
    made.push(d);
    execFileSync('git', ['init', '-q', d]);
    mkdirSync(join(d, '.SBX'));
    writeFileSync(join(d, '.SBX', 'sandbox.json'), '{}\n');
    execFileSync('git', ['add', '.SBX'], { cwd: d });
    // On a case-sensitive filesystem .sbx/ must exist for the check to look: make it, as the
    // case-insensitive one already has it (the same directory as .SBX/).
    if (!existsSync(join(d, '.sbx'))) mkdirSync(join(d, '.sbx'));
    expect(sbxDirProblem(d)).toMatch(/tracked by git/);
    expect(conflictOf(() => writeAgentConfig(d)).message).toMatch(/^\.sbx is tracked by git/);
  });

  it('refuses a target linked into .git', () => {
    const d = dir();
    writeFileSync(join(d, '.git', 'config'), '[core]\n');
    symlinkSync('.git/config', join(d, '.mcp.json'));
    expect(conflictOf(() => writeAgentConfig(d)).message).toMatch(
      /\.mcp\.json is a link into \.git/,
    );
    expect(readFileSync(join(d, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });
});
