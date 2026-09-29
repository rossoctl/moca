import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import type { LoadSkillsResult } from '@earendil-works/pi-coding-agent';
import { assertValidDigest, digestDirName, untar, type TarEntry } from '@moca/config-bundle';
import { getBundle, type BundleRedisLike } from './config-store.js';

/** The harness pod mounts no writable volume except an emptyDir /tmp (ADR-0020). */
export const DEFAULT_CONFIG_BASE_DIR = '/tmp/sh-config';

export interface PromotedConfig {
  digest: string;
  root: string;
  skillsDir: string;
  promptsDir: string;
  /**
   * Where the SAME skills are readable from the sandbox — the per-leaf link that `overlayConfig`
   * returns. Set only once the overlay has actually landed, because it is only true then: absent,
   * pi's tools run in this pod (run-turn.ts:456-460) and `skillsDir` is itself the reachable path.
   */
  sandboxSkillsDir?: string;
  /** Injected inline via agentsFilesOverride — never written to disk. */
  context: Array<{ path: string; content: string }>;
  promptFragments: string[];
  /** The whole bundle, handed to the sandbox overlay so both halves share one digest. */
  entries: TarEntry[];
}

export interface PromotedLoaderOptions {
  additionalSkillPaths: string[];
  additionalPromptTemplatePaths: string[];
  noContextFiles: true;
  noSkills: true;
  noPromptTemplates: true;
  agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
    agentsFiles: Array<{ path: string; content: string }>;
  };
  appendSystemPrompt: string[];
  /** Present only when a sandbox overlay landed — see rewriteToSandbox below. */
  skillsOverride?: (base: LoadSkillsResult) => LoadSkillsResult;
}

/**
 * Unpack into a digest-named directory. Digest-keyed means the cache can never be stale, so
 * its death with the pod is correct rather than unfortunate.
 *
 * Unpack goes to a temp dir and is renamed into place: a crash mid-unpack must never leave a
 * half-populated skill directory, which would silently truncate a skill's instructions.
 */
export function unpackBundle(
  tar: Buffer,
  digest: string,
  baseDir: string = DEFAULT_CONFIG_BASE_DIR,
): PromotedConfig {
  const entries = untar(tar);
  const root = join(baseDir, digestDirName(assertValidDigest(digest)));

  if (!existsSync(root)) {
    mkdirSync(baseDir, { recursive: true });
    const staging = mkdtempSync(join(baseDir, '.tmp-'));
    try {
      for (const entry of entries) {
        // Path safety is checked for EVERY entry, before the prefix filter. Checking it after
        // would let a traversal path outside skills//prompts/ be silently skipped rather than
        // rejected, which is a weaker guarantee than "no bundle can write outside its root".
        const target = resolve(staging, entry.path);
        if (target !== staging && !target.startsWith(staging + sep)) {
          throw new Error(`bundle entry escapes the unpack root: ${entry.path}`);
        }
        // Only skills/ and prompts/ need to be files; context/ and prompt/ are read into memory,
        // and memory/ is destined for the sandbox.
        if (!entry.path.startsWith('skills/') && !entry.path.startsWith('prompts/')) continue;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, entry.content, { mode: entry.mode ?? 0o644 });
      }
      mkdirSync(join(staging, 'skills'), { recursive: true });
      mkdirSync(join(staging, 'prompts'), { recursive: true });
      renameSync(staging, root);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      // An EEXIST/ENOTEMPTY rename means a concurrent turn in this pod won the race; that is
      // fine, because identical digests mean identical content.
      if (!existsSync(root)) throw err;
    }
  }

  // Numeric-aware where an index is present: a plain lexicographic sort puts `append-10` before
  // `append-2`, silently reordering injected prompt notes. Unreachable today (only two fragments are
  // ever produced) but the cost of being wrong later is a scrambled system prompt.
  const indexOf = (p: string): number => {
    const m = /-(\d+)\.md$/.exec(p);
    return m ? Number(m[1]) : Number.NaN;
  };
  const text = (prefix: string) =>
    entries
      .filter((e) => e.path.startsWith(prefix))
      .sort((a, b) => {
        const ia = indexOf(a.path);
        const ib = indexOf(b.path);
        if (!Number.isNaN(ia) && !Number.isNaN(ib) && ia !== ib) return ia - ib;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });

  return {
    digest,
    root,
    skillsDir: join(root, 'skills'),
    promptsDir: join(root, 'prompts'),
    context: text('context/').map((e) => ({ path: e.path, content: e.content.toString('utf8') })),
    promptFragments: text('prompt/').map((e) => e.content.toString('utf8')),
    entries,
  };
}

/** Prefix swap. Anything outside `from` is returned untouched, so a skill that somehow came from
 * elsewhere keeps a path that is true for wherever it came from. */
function swapPrefix(p: string, from: string, to: string): string {
  if (p === from) return to;
  return p.startsWith(from + sep) ? to + p.slice(from.length) : p;
}

/**
 * Rewrite each loaded skill's paths from this pod's copy to the sandbox's (issue #222).
 *
 * `additionalSkillPaths` MUST stay pod-side — pi reads every SKILL.md off this pod's disk to parse
 * its frontmatter — but the path it then ADVERTISES to the model is that same string:
 * `<location>{skill.filePath}</location>` in pi-fork `skills.ts:354`, under a heading that says to
 * use the read tool on it. Every tool call runs in the SANDBOX, where `/tmp/sh-config/<digest>`
 * does not exist, so the model is handed a dead path for the skill and must infer a different one
 * for that skill's sibling files. Observed: it reached for the pod path first and got "File not
 * readable in pod" — a concrete path in the prompt beats the prose in `notes.ts` that points at
 * the injected "Skill files:" directory instead.
 *
 * Rewriting AFTER the load, rather than pointing pi at the sandbox path, is what keeps both true
 * at once: loading still happens from the pod copy, and exactly one path — the reachable one —
 * reaches the model.
 *
 * `baseDir` moves with `filePath` to keep the two in agreement, NOT because the skills preamble
 * names it: that preamble (`skills.ts:346`) says to resolve a skill's relative references against
 * "the skill directory (parent of SKILL.md / dirname of the path)", so the model derives the
 * directory from `filePath` and never sees `baseDir` there. The one place `baseDir` does reach a
 * model is the `/skill:<name>` expansion block (`agent-session.ts:1186`, "References are relative
 * to …"), which no harness path triggers today — a prompt would have to literally start with
 * `/skill:` — so it must be sandbox-side for the day one does.
 *
 * `sourceInfo` is deliberately NOT rewritten. It describes PROVENANCE, and the provenance genuinely
 * is the pod copy; nothing model-facing reads it (`formatSkillsForPrompt` renders only `name`,
 * `description` and `filePath`). Note that leaving it alone is what actually keeps it pod-side:
 * `resource-loader.ts:616-622` recomputes it after this override as
 * `findSourceInfoForPath(skill.filePath, …) ?? skill.sourceInfo ?? getDefaultSourceInfoForPath(…)`,
 * and that first lookup is handed the REWRITTEN path against maps keyed by pod paths, so it misses
 * and falls through to the parse-time pod-side value.
 */
function rewriteToSandbox(podSkillsDir: string, sandboxSkillsDir: string) {
  return (base: LoadSkillsResult): LoadSkillsResult => ({
    diagnostics: base.diagnostics,
    skills: base.skills.map((s) => ({
      ...s,
      filePath: swapPrefix(s.filePath, podSkillsDir, sandboxSkillsDir),
      baseDir: swapPrefix(s.baseDir, podSkillsDir, sandboxSkillsDir),
    })),
  });
}

/**
 * Options that point pi at the bundle and suppress all discovery.
 *
 * `noSkills: true` still honours `additionalSkillPaths` — resource-loader.ts:405-407 merges them
 * in both branches — so this yields exactly the bundle's skills and nothing from the pod.
 *
 * `appendSystemPrompt` strings are passed as literal text. Note that pi's `resolvePromptInput`
 * (resource-loader.ts:49) reads a string as a FILE when `existsSync(input)`; our fragments are
 * multi-line prose, so they can never collide with a real path.
 */
export function buildLoaderOptions(promoted: PromotedConfig): PromotedLoaderOptions {
  return {
    additionalSkillPaths: [promoted.skillsDir],
    additionalPromptTemplatePaths: [promoted.promptsDir],
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    // Ignores `base` deliberately — see the leak regression test in test/config-resolver.test.ts.
    agentsFilesOverride: () => ({ agentsFiles: promoted.context }),
    appendSystemPrompt: promoted.promptFragments,
    // Only when an overlay landed. With no sandbox, pi's tools run in this pod, where the pod-side
    // path is the correct one — rewriting it there would break the one case it is true for.
    ...(promoted.sandboxSkillsDir
      ? { skillsOverride: rewriteToSandbox(promoted.skillsDir, promoted.sandboxSkillsDir) }
      : {}),
  };
}

/** Spread into the loader construction. Empty when nothing is promoted: behavior is unchanged. */
export function promotedLoaderOptions(
  promoted?: PromotedConfig,
): PromotedLoaderOptions | Record<string, never> {
  return promoted ? buildLoaderOptions(promoted) : {};
}

/** Fetch, verify and unpack. Throws (never degrades) on a missing or corrupt bundle. */
export async function resolvePromotedConfig(
  redis: BundleRedisLike,
  digest: string,
  baseDir: string = DEFAULT_CONFIG_BASE_DIR,
): Promise<PromotedConfig> {
  return unpackBundle(await getBundle(redis, digest), digest, baseDir);
}
