import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { classifySkills, detectBinaries } from './classify.js';
import { formatEntry } from './format.js';
import { buildLockfile, serializeLockfile, skillContentHash } from './lockfile.js';
import { skillsRootNote, toolNameMappingNote } from './notes.js';
import {
  checkBinaries,
  checkEntry,
  checkInteraction,
  checkMemoryLinks,
  checkNamespacedPrompts,
  checkSiblingPaths,
  checkExcludedPrompts,
} from './preflight.js';
import { isWithin, resolveSkills } from './resolve.js';
import { blockingSecrets, scanEntriesForSecrets, SecretScanError } from './secret-scan.js';
import { canonicalTar, digestOf } from './tar.js';
import type { BuildBundleInput, BuildResult, PreflightFinding, TarEntry } from './types.js';

export const LOCKFILE_PATH = 'lockfile.json';

/**
 * The bundle's identity: a digest over the CONTENT entries only.
 *
 * `lockfile.json` records the digest, so including it would make the digest depend on itself.
 * Both the builder and the resolver (harness/src/config-resolver.ts) call this exact function,
 * so their notions of identity cannot drift.
 */
export function contentDigest(entries: TarEntry[]): string {
  return digestOf(canonicalTar(entries.filter((e) => e.path !== LOCKFILE_PATH)));
}

/** `.md` files directly in `dir`, sorted. Empty when the directory is absent. */
function markdownFiles(dir: string | undefined, findings: PreflightFinding[]): string[] {
  if (!dir || !existsSync(dir)) return [];
  const root = realpathSync(dir);
  return readdirSync(dir)
    .filter((n) => {
      const p = join(dir, n);
      if (!n.endsWith('.md') || !statSync(p).isFile()) return false;
      if (isWithin(root, realpathSync(p))) return true;
      findings.push({
        severity: 'warn',
        code: 'skill_symlink_escaped',
        message: `symlink '${n}' resolves outside its directory and was skipped`,
        path: dir,
      });
      return false;
    })
    .sort();
}

/**
 * Subdirectory names directly under `dir` that hold at least one `.md` file -- Claude Code's
 * namespaced-command layout (`commands/<ns>/<cmd>.md`). `markdownFiles` above deliberately does
 * not recurse into these (spec §2/§9, out of scope with MCP servers and subagents); this is the
 * fs-scanning half of that decision, feeding `checkNamespacedPrompts` so the drop is a warning
 * rather than silence. Sorted; empty when `dir` is absent.
 */
function namespacedPromptDirs(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let children: string[];
    try {
      children = readdirSync(p);
    } catch {
      continue;
    }
    const hasMd = children.some((n) => {
      try {
        return n.endsWith('.md') && statSync(join(p, n)).isFile();
      } catch {
        return false;
      }
    });
    if (hasMd) out.push(name);
  }
  return out;
}

export function buildBundle(input: BuildBundleInput): BuildResult {
  const classification = classifySkills(resolveSkills(input.roots), {
    mode: input.mode,
    userDenyList: input.userDenyList,
  });

  const entries: TarEntry[] = [];

  // Skill directories travel WHOLE: skills reference siblings and carry references/ subtrees.
  for (const skill of classification.travels) {
    for (const rel of skill.files) {
      const abs = join(skill.dir, rel);
      entries.push({
        path: `skills/${skill.name}/${rel}`,
        content: readFileSync(abs),
        mode: rel.endsWith('.sh') ? 0o755 : 0o644,
      });
    }
  }

  // Inline-injected context: the CLAUDE.md chain plus the memory index.
  const contextPaths: string[] = [];
  (input.contextFiles ?? []).forEach((file, i) => {
    const path = `context/agents/${i}-${basename(file.path)}`;
    entries.push({ path, content: Buffer.from(file.content, 'utf8') });
    contextPaths.push(path);
  });

  const fsFindings: PreflightFinding[] = [];
  const memoryFiles = markdownFiles(input.memoryDir, fsFindings);
  const memoryNames = memoryFiles.filter((n) => n !== 'MEMORY.md');
  let memoryIndex: string | undefined;
  if (input.memoryDir && memoryFiles.includes('MEMORY.md')) {
    memoryIndex = readFileSync(join(input.memoryDir, 'MEMORY.md'), 'utf8');
    entries.push({ path: 'context/MEMORY.md', content: Buffer.from(memoryIndex, 'utf8') });
    contextPaths.push('context/MEMORY.md');
  }

  // Memory files are read on demand IN THE SANDBOX (ADR-0031 progressive disclosure), so they
  // are bundle content rather than inline context.
  const memoryPaths: string[] = [];
  for (const name of memoryNames) {
    const path = `memory/${name}`;
    entries.push({ path, content: readFileSync(join(input.memoryDir!, name)) });
    memoryPaths.push(path);
  }

  const excluded = new Set(input.excludePrompts ?? []);
  const excludedSeen = new Set<string>();
  const promptNames: string[] = [];
  for (const name of markdownFiles(input.promptsDir, fsFindings)) {
    const promptName = name.replace(/\.md$/, '');
    if (excluded.has(promptName)) {
      excludedSeen.add(promptName);
      continue;
    }
    entries.push({
      path: `prompts/${name}`,
      content: readFileSync(join(input.promptsDir!, name)),
    });
    promptNames.push(promptName);
  }

  const fragments = [
    toolNameMappingNote(),
    skillsRootNote(),
    ...(input.extraPromptFragments ?? []),
  ];
  fragments.forEach((text, i) => {
    entries.push({ path: `prompt/append-${i}.md`, content: Buffer.from(text, 'utf8') });
  });

  // The format version travels as content (#510), so the store keeps it and the digest covers it.
  entries.push(formatEntry());

  // Blocking gate: a credential reaching a shared cluster's store is not recoverable by
  // re-promoting, so nothing is packed or returned when the scan is dirty (spec §4.3).
  const secrets = scanEntriesForSecrets(entries);
  const blocking = blockingSecrets(secrets);
  if (blocking.length > 0) throw new SecretScanError(blocking);

  const digest = contentDigest(entries);
  const binaries = detectBinaries(classification.travels);
  const skillHashes: Record<string, string> = {};
  for (const skill of classification.travels) {
    skillHashes[skill.name] = skillContentHash(skill, entries);
  }

  const lockfile = buildLockfile({
    digest,
    mode: input.mode,
    entry: input.entry ?? '',
    classification,
    contextPaths,
    memoryPaths,
    sandboxImage: input.sandboxImage,
    binaries,
    versions: input.versions,
    skillHashes,
  });

  const findings: PreflightFinding[] = [
    // Non-blocking secret hits travel as warnings so a human still sees them in the report.
    ...secrets
      .filter((f) => f.severity === 'warning')
      .map((f) => ({
        severity: 'warn' as const,
        code: 'possible_secret',
        message: `possible secret (${f.rule}) — verify before promoting`,
        path: `${f.path}:${f.line}`,
      })),
    // Findings raised while resolving each skill's own files (e.g. a symlink that escaped its
    // skill directory and was skipped -- resolve.ts's `filesUnder`).
    ...classification.travels.flatMap((skill) => skill.findings ?? []),
    ...fsFindings,
    ...checkSiblingPaths(classification.travels),
    ...checkMemoryLinks(memoryIndex, memoryNames),
    ...checkBinaries(binaries, input.inventory),
    // Suppressed when the entry is what was excluded: `entry_excluded` already names the cause,
    // and `unknown_entry` would report the symptom of it as a second, independent-looking error.
    ...(input.entry === undefined || excluded.has(input.entry)
      ? []
      : checkEntry(input.entry, promptNames)),
    ...checkInteraction(classification),
    ...checkNamespacedPrompts(namespacedPromptDirs(input.promptsDir)),
    ...checkExcludedPrompts(input.entry, input.excludePrompts ?? [], excludedSeen),
  ];

  const tar = canonicalTar([
    ...entries,
    { path: LOCKFILE_PATH, content: Buffer.from(serializeLockfile(lockfile), 'utf8') },
  ]);

  return { tar, digest, lockfile, findings, promptNames };
}
