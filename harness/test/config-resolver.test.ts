import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalTar, contentDigest } from '@moca/config-bundle';
import {
  DefaultResourceLoader,
  formatSkillsForPrompt,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import { unpackBundle, buildLoaderOptions, promotedLoaderOptions } from '../src/config-resolver.js';

let base: string;

const bundle = () => {
  const entries = [
    {
      path: 'skills/keeper/SKILL.md',
      content: Buffer.from('---\nname: keeper\ndescription: d\n---\nbody'),
    },
    { path: 'skills/keeper/references/g.md', content: Buffer.from('guide') },
    { path: 'prompts/go.md', content: Buffer.from('do it') },
    { path: 'context/agents/0-CLAUDE.md', content: Buffer.from('# promoted project rules') },
    { path: 'context/MEMORY.md', content: Buffer.from('- [A](alpha.md)') },
    { path: 'memory/alpha.md', content: Buffer.from('fact') },
    // append-2 / append-10, not append-0 / append-1: canonicalTar always sorts entries
    // byte-wise before writing (tar.ts), so untar hands unpackBundle entries in lexicographic
    // path order regardless of this array's order -- reversing the source order alone changes
    // nothing observable. What DOES distinguish "sorted" from "not sorted" is a pair whose
    // lexicographic order differs from its numeric order: byte-wise, 'append-10.md' < 'append-2.md'
    // ('1' < '2'), so a plain pass-through (or a non-numeric-aware sort) yields ten-before-two,
    // while the numeric-aware comparator in unpackBundle correctly yields two-before-ten. This
    // fixture fails if that comparator is removed, reversed, or degraded to lexicographic.
    { path: 'prompt/append-10.md', content: Buffer.from('note ten\nsecond line') },
    { path: 'prompt/append-2.md', content: Buffer.from('note two\nsecond line') },
  ];
  return { tar: canonicalTar(entries), digest: contentDigest(entries) };
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'sh-config-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('unpackBundle', () => {
  it('materializes skills and prompts as real files (pi reads skill bodies from disk)', () => {
    const { tar, digest } = bundle();
    const p = unpackBundle(tar, digest, base);
    expect(existsSync(join(p.skillsDir, 'keeper', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(p.skillsDir, 'keeper', 'references', 'g.md'), 'utf8')).toBe('guide');
    expect(existsSync(join(p.promptsDir, 'go.md'))).toBe(true);
  });

  it('returns context inline, ordered, without writing it to disk', () => {
    const { tar, digest } = bundle();
    const p = unpackBundle(tar, digest, base);
    expect(p.context.map((c) => c.path)).toEqual([
      'context/MEMORY.md',
      'context/agents/0-CLAUDE.md',
    ]);
    expect(p.context.find((c) => c.path.endsWith('0-CLAUDE.md'))!.content).toContain('promoted');
  });

  it('returns prompt fragments in numeric append-N order, not lexicographic', () => {
    // 'append-10.md' sorts before 'append-2.md' lexicographically (and that is the order
    // canonicalTar itself writes them in), so this only passes if unpackBundle's comparator is
    // genuinely numeric-aware -- a no-op sort or a plain string sort both produce ten-before-two.
    const { tar, digest } = bundle();
    expect(unpackBundle(tar, digest, base).promptFragments[0]).toContain('note two');
    expect(unpackBundle(tar, digest, base).promptFragments[1]).toContain('note ten');
  });

  it('is idempotent and leaves no temp directory behind', () => {
    const { tar, digest } = bundle();
    unpackBundle(tar, digest, base);
    unpackBundle(tar, digest, base);
    expect(readdirSync(base).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('names the directory after the digest so the cache can never be stale', () => {
    const { tar, digest } = bundle();
    expect(unpackBundle(tar, digest, base).root).toBe(join(base, digest.replace(':', '-')));
  });

  it('rejects an entry path that escapes the unpack root', () => {
    const evil = canonicalTar([{ path: '../escape.md', content: Buffer.from('x') }]);
    expect(() => unpackBundle(evil, 'sha256:' + '0'.repeat(64), base)).toThrow(/escapes/);
  });

  it('rejects an absolutely-rooted entry path', () => {
    // `resolve(staging, '/etc/passwd')` discards the base entirely, landing outside staging. The
    // brief names this case explicitly, so it gets its own test rather than relying on the
    // traversal case above.
    const evil = canonicalTar([{ path: '/etc/passwd', content: Buffer.from('x') }]);
    expect(() => unpackBundle(evil, 'sha256:' + '1'.repeat(64), base)).toThrow(/escapes/);
  });

  it('removes the staging directory when unpacking fails', () => {
    // Cleanup correctness was previously verified only by reading the code, so a regression in the
    // rmSync would have gone undetected and leaked a staging dir per failed unpack in a pod's /tmp.
    const evil = canonicalTar([{ path: '../escape.md', content: Buffer.from('x') }]);
    expect(() => unpackBundle(evil, 'sha256:' + '2'.repeat(64), base)).toThrow(/escapes/);
    expect(readdirSync(base).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('rejects a malformed digest before touching the filesystem at all (Fix B: defense-in-depth)', () => {
    // digestDirName joins whatever it's given onto baseDir with no further checking; without
    // assertValidDigest running first, a digest shaped 'sha256:../../../evil' would turn into a
    // directory name that -- once digestDirName's ':' -> '-' substitution is undone by eye --
    // walks straight out of `base`. This asserts base itself never gains a directory at all
    // (traversal or not), which is only true if the digest is rejected before `mkdirSync(baseDir)`
    // and the staging mkdtemp ever run.
    const { tar } = bundle();
    const evilDigest = 'sha256:../../../evil';
    expect(() => unpackBundle(tar, evilDigest, base)).toThrow(/invalid digest/i);
    // base was freshly created empty by beforeEach and nothing in this test wrote to it before the
    // call above, so any entry here would have to have come from unpackBundle.
    expect(readdirSync(base)).toEqual([]);
  });
});

describe('buildLoaderOptions', () => {
  const { tar, digest } = bundle();

  it('points pi at the bundle and suppresses discovery', () => {
    const o = buildLoaderOptions(unpackBundle(tar, digest, base));
    expect(o.additionalSkillPaths).toHaveLength(1);
    expect(o.noContextFiles).toBe(true);
    expect(o.noSkills).toBe(true);
    expect(o.noPromptTemplates).toBe(true);
  });

  it('supplies context through agentsFilesOverride, ignoring the base entirely', () => {
    const o = buildLoaderOptions(unpackBundle(tar, digest, base));
    const out = o.agentsFilesOverride({
      agentsFiles: [{ path: '/leak/CLAUDE.md', content: 'leak' }],
    });
    expect(out.agentsFiles.map((f) => f.path)).not.toContain('/leak/CLAUDE.md');
  });

  it('installs no skillsOverride when no overlay landed — the pod path is then the reachable one', () => {
    // With no sandbox, pi's tools run in the harness pod itself (run-turn.ts logs "tools run
    // LOCAL"), where the unpacked pod-side copy IS readable. Rewriting the advertised path in
    // that case would break the one deployment where the pod path is correct.
    const o = buildLoaderOptions(unpackBundle(tar, digest, base));
    expect('skillsOverride' in o).toBe(false);
  });
});

describe('promotedLoaderOptions', () => {
  it('is EMPTY when no bundle is promoted — this is the unchanged-behavior guarantee', () => {
    expect(Object.keys(promotedLoaderOptions(undefined))).toEqual([]);
  });
});

// REGRESSION TEST — do not delete. The harness CLAUDE.md leak.
//
// loadProjectContextFiles (pi-fork resource-loader.ts:62) walks ancestor directories for
// CLAUDE.md/AGENTS.md. Run inside this repository, that walk reaches OUR OWN CLAUDE.md
// ("MOCA ... pnpm workspace ... DCO sign-off required"). Unsuppressed, every
// promoted session would silently inherit the harness project's instructions as if they were
// the user's. It fails as plausible-but-wrong behavior, never as an error, so nothing else
// would catch it.
//
// TWO mechanisms close it and both are deliberate: agentsFilesOverride ignores the base, and
// noContextFiles makes the base empty. The override alone is sufficient TODAY — but a
// natural-looking future edit to `(base) => ({agentsFiles: [...base.agentsFiles, ...ours]})`
// would reopen the leak, and noContextFiles keeps it shut even then.
describe('harness CLAUDE.md leak', () => {
  it('never exposes the harness project CLAUDE.md to a promoted session', async () => {
    const { tar, digest } = bundle();
    const promoted = unpackBundle(tar, digest, base);
    const repoRoot = resolve(__dirname, '..', '..');
    expect(readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8')).toContain('MOCA');

    const loader = new DefaultResourceLoader({
      cwd: repoRoot,
      agentDir: getAgentDir(),
      ...buildLoaderOptions(promoted),
    });
    await loader.reload();

    const files = loader.getAgentsFiles().agentsFiles;
    expect(files.some((f) => f.content.includes('MOCA'))).toBe(false);
    expect(files.some((f) => f.content.includes('promoted project rules'))).toBe(true);
  });

  it('loads exactly the bundle skills and nothing discovered', async () => {
    const { tar, digest } = bundle();
    const loader = new DefaultResourceLoader({
      cwd: resolve(__dirname, '..', '..'),
      agentDir: getAgentDir(),
      ...buildLoaderOptions(unpackBundle(tar, digest, base)),
    });
    await loader.reload();
    // Pins the semantics found at resource-loader.ts:405-407: noSkills still honours
    // additionalSkillPaths, so this yields the bundle's skills only.
    expect(loader.getSkills().skills.map((s) => s.name)).toEqual(['keeper']);
  });
});

// REGRESSION TEST — do not delete. Issue #222 (2): a skill advertised at a path `read` cannot see.
//
// `additionalSkillPaths` has to stay pod-side: pi parses each SKILL.md off THIS pod's disk. But the
// path it then hands the model — `<location>` in formatSkillsForPrompt (pi-fork skills.ts:354) — is
// that same string, and every tool call runs in the SANDBOX, where /tmp/sh-config/<digest> does not
// exist. Observed: the model reached for the pod path FIRST and got "File not readable in pod",
// because a concrete path in the prompt beats the prose note in notes.ts that tells it to use the
// per-leaf sandbox directory instead. Assert on the rendered prompt, not just on the field: the
// prompt is what the model actually sees.
describe('the advertised skill location', () => {
  const sandboxSkills = '/workspace/leaves/run-1-i1/.sh-config/skills';

  it('is the sandbox path, and the pod path appears nowhere in the prompt', async () => {
    const { tar, digest } = bundle();
    const promoted = { ...unpackBundle(tar, digest, base), sandboxSkillsDir: sandboxSkills };
    const loader = new DefaultResourceLoader({
      cwd: resolve(__dirname, '..', '..'),
      agentDir: getAgentDir(),
      ...buildLoaderOptions(promoted),
    });
    await loader.reload();

    const skills = loader.getSkills().skills;
    expect(skills.map((s) => s.name)).toEqual(['keeper']);
    expect(skills[0]!.filePath).toBe(`${sandboxSkills}/keeper/SKILL.md`);
    // baseDir too: pi's own prompt text tells the model to resolve a skill's relative references
    // against the skill directory, so a pod-side baseDir reintroduces the same dead path.
    expect(skills[0]!.baseDir).toBe(`${sandboxSkills}/keeper`);

    const rendered = formatSkillsForPrompt(skills);
    expect(rendered).toContain(`<location>${sandboxSkills}/keeper/SKILL.md</location>`);
    expect(rendered).not.toContain(base);
  });

  it('still lets pi load the skill body from the pod copy it was unpacked into', async () => {
    // The rewrite must not disturb loading: the frontmatter below was read off `base`, so a
    // rewrite applied before the read (or to additionalSkillPaths) would yield zero skills.
    const { tar, digest } = bundle();
    const promoted = { ...unpackBundle(tar, digest, base), sandboxSkillsDir: sandboxSkills };
    const loader = new DefaultResourceLoader({
      cwd: resolve(__dirname, '..', '..'),
      agentDir: getAgentDir(),
      ...buildLoaderOptions(promoted),
    });
    await loader.reload();
    expect(loader.getSkills().skills[0]!.description).toBe('d');
    expect(loader.getSkills().diagnostics.filter((d) => d.type === 'error')).toEqual([]);
  });
});
