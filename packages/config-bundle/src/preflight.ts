import type { Classification, PreflightFinding, ResolvedSkill } from './types.js';

/** Backticked tokens that look like a relative file path (have a slash or a known extension). */
function referencedPaths(skillMd: string): string[] {
  const out = new Set<string>();
  for (const m of skillMd.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1]!.trim();
    if (!token || /^https?:\/\//.test(token) || token.startsWith('-')) continue;
    if (/\s/.test(token)) continue;
    // Extension must start with a letter (kills versions like 1.2.3, IPs like 127.0.0.1)
    if (!/\.[a-z][a-z0-9]{0,4}$/i.test(token)) continue;
    // Reject tokens with glob/comparison operators (kills *.md, node>=18.0, etc)
    if (/[*?<>=|]/.test(token)) continue;
    out.add(token.replace(/^\.\//, ''));
  }
  return [...out];
}

/** Every ancestor directory prefix of a path, e.g. `a/b/c.md` -> [`a/`, `a/b/`]. Exact strings; no `startsWith` fuzz. */
function ancestorPrefixes(p: string): string[] {
  const out: string[] = [];
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) {
    out.push(p.slice(0, i + 1));
  }
  return out;
}

/**
 * A skill referencing a path the bundle does not ship would fail remotely as a confusing read
 * miss. The bundle carries each skill's own directory and nothing else, so a reference that
 * resolves perfectly well on the author's machine can still be absent when the skill runs.
 *
 * That is usually what this fires on, and the message says so (#628): a repository with a
 * top-level `scripts/` beside skills that ship `scripts/*.py` warns on `scripts/build.sh`, because
 * the skill owns `scripts/` by the rule below while the file itself lives at the repo root and
 * never travels. It is a true finding -- the remote read really would miss -- so the wording has to
 * name non-inclusion rather than imply the author misplaced the file.
 *
 * Two deliberate restrictions, both measured against a real `~/.claude`:
 *
 * 1. **Only references the skill plausibly owns are flagged** — the reference must contain a `/`
 *    AND its directory prefix must be a directory the skill actually ships files in. Without this
 *    the check fired 182 times across 28 skills, because a skill's prose names plenty of paths it
 *    does not ship: `main.py`, `requirements.txt`, `package.json` (files the reader will create),
 *    `window.open` and `sys.path` (code), bare `.md`/`.py` (from "a `.md` file"), and example
 *    project trees. `main.py` and `references/guide.md` are indistinguishable in shape, so no
 *    regex separates them — only "does the skill own this directory" does. The rule cuts 182 to 9.
 *
 *    Ownership must be checked symmetrically against EVERY ancestor on both sides, not just each
 *    path's immediate parent — two failure directions, both measured:
 *      - ships `references/deep/x.md`, references missing `references/missing.md`: the skill's
 *        immediate parent is `references/deep/`, but it still owns `references/` (an ancestor of
 *        what it ships).
 *      - ships `references/guide.md`, references missing `references/deep/missing.md`: the
 *        reference's immediate directory `references/deep/` was never shipped, but its ancestor
 *        `references/` demonstrably is owned.
 *    Both sides are expanded into their full ancestor-prefix set and checked for exact-string
 *    intersection — never `startsWith` — so `references-old/` still does not satisfy a reference
 *    under `references/`; `references-old` and `references` are different path segments and never
 *    appear as the same string in either set.
 * 2. **Warn, not error.** The 9 survivors are still false positives (one skill documenting
 *    hypothetical `references/*.md` because its subject is how to write skills), so blocking would
 *    refuse promotion for anyone who has it installed. Preflight blocks only on facts.
 *
 * Satisfaction stays deliberately loose: a reference counts if any bundled path equals it, ends
 * with `/<ref>`, or the reference ends with the path — skills write paths relative to their own
 * directory or to the plugin root, and both are legitimate.
 */
export function checkSiblingPaths(skills: ResolvedSkill[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const skill of skills) {
    const ownedDirs = new Set(skill.files.flatMap(ancestorPrefixes));
    for (const ref of referencedPaths(skill.skillMd)) {
      if (skill.files.some((f) => f === ref || f.endsWith('/' + ref) || ref.endsWith(f))) continue;
      if (!ref.includes('/')) continue; // a bare filename is prose, not a sibling claim
      if (!ancestorPrefixes(ref).some((d) => ownedDirs.has(d))) continue; // skill does not own it
      findings.push({
        severity: 'warn',
        code: 'missing_sibling',
        message:
          `skill '${skill.name}' references '${ref}', which is not included in the bundle` +
          " — only files under the skill's own directory travel",
        path: skill.dir,
      });
    }
  }
  return findings;
}

/** Skip non-local link targets (external URLs, protocol-relative, fragments, queries, or outside memory dir). */
function isLocalMemoryLink(target: string): boolean {
  // Has URI scheme (https:, http:, mailto:, etc)
  if (/^[a-z][a-z0-9+.-]*:/.test(target)) return false;
  // Protocol-relative
  if (/^\/\//.test(target)) return false;
  // Fragment or query-only
  if (/^[#?]/.test(target)) return false;
  // Contains .. path segment (outside memory directory)
  if (/\.\./.test(target)) return false;
  return true;
}

/** Dangling links in MEMORY.md (both markdown `[title](file.md)` and `[[wikilink]]` forms) — usually deny-listed memory files. Warn, not error. */
export function checkMemoryLinks(
  memoryIndex: string | undefined,
  includedMemoryNames: string[],
): PreflightFinding[] {
  if (!memoryIndex) return [];
  const slugs = new Set(includedMemoryNames.map((n) => n.replace(/\.md$/, '')));
  const findings: PreflightFinding[] = [];

  // Extract markdown links: [Title](target.md)
  // Quantifiers are BOUNDED and newline-excluded to stop a quadratic blow-up: the unbounded
  // /\[([^\]]+)\]\(([^)]+)\)/ rescans from every '[', measured at 2.3 s on 40 KB of '[' and
  // getting quadratically worse. Promote scans third-party plugin skills, so this input is not
  // necessarily the user's own. Real memory links are far inside these bounds.
  for (const m of memoryIndex.matchAll(/\[([^\]\n]{1,300})\]\(([^)\n]{1,500})\)/g)) {
    const target = m[2]!.trim();
    // Skip non-local targets (external URLs, relative paths outside memory, etc)
    if (!isLocalMemoryLink(target)) continue;
    // Strip directory prefix and .md extension
    const slug = target.replace(/^.*\//, '').replace(/\.md$/, '');
    if (!slugs.has(slug)) {
      findings.push({
        severity: 'warn',
        code: 'dangling_memory_link',
        message: `MEMORY.md links [${m[1]}](${target}), which is not included in the bundle`,
      });
    }
  }

  // Extract wikilinks: [[slug]] or [[slug|alias]] or [[path/slug]]
  // Bounded for the same reason: the unbounded form measured 9.2 s on 80 KB of '[['.
  for (const m of memoryIndex.matchAll(/\[\[([^\]\n]{1,300})\]\]/g)) {
    const full = m[1]!.trim();
    // Strip |alias suffix
    const withoutAlias = full.split('|')[0]!.trim();
    // Skip non-local targets (external URLs, relative paths outside memory, etc)
    if (!isLocalMemoryLink(withoutAlias)) continue;
    // Strip path prefix to get slug
    const slug = withoutAlias.replace(/^.*\//, '');
    if (!slugs.has(slug)) {
      findings.push({
        severity: 'warn',
        code: 'dangling_memory_link',
        message: `MEMORY.md links [[${full}]], which is not included in the bundle`,
      });
    }
  }

  return findings;
}

/**
 * Warns, never errors. Measured against a real ~/.claude (55 travelling skills), the fenced-block
 * scan that feeds `detected` produced 44 binaries and 32 "missing" against the shipped inventory —
 * roughly half not commands at all (`angular`, `django`, `express`, `fastapi`, `vue`, `prisma`,
 * `branch`, `rev-parse`, even the literal placeholder `your_command`). First-word-of-a-shell-fence
 * cannot distinguish a command from prose, so blocking on it refused nearly every real promotion
 * for mostly bogus reasons. A genuinely missing tool still fails remotely with a legible
 * `gh: not found`, which is diagnosable and re-promotable — that is an acceptable failure mode;
 * refusing every promotion up front is not.
 */
export function checkBinaries(
  detected: string[],
  inventory: string[] | undefined,
): PreflightFinding[] {
  if (!inventory) {
    return detected.length === 0
      ? []
      : [
          {
            severity: 'warn',
            code: 'inventory_unavailable',
            message:
              `no sandbox inventory available; ${detected.length} detected binary/binaries ` +
              `(${detected.join(', ')}) could not be verified`,
          },
        ];
  }
  const have = new Set(inventory);
  return detected
    .filter((b) => !have.has(b))
    .map((b) => ({
      severity: 'warn' as const,
      code: 'missing_binary',
      message: `binary '${b}' is used by a skill but is not in the sandbox image inventory`,
    }));
}

export function checkEntry(entry: string, promptNames: string[]): PreflightFinding[] {
  return promptNames.includes(entry)
    ? []
    : [
        {
          severity: 'error',
          code: 'unknown_entry',
          message:
            `entry prompt '${entry}' is not in the bundle ` +
            `(available: ${promptNames.join(', ') || 'none'})`,
        },
      ];
}

/** Interaction dependence is mode-sensitive, so it warns and never drops (spec D8). */
export function checkInteraction(classification: Classification): PreflightFinding[] {
  return classification.interactionDependent.map((name) => ({
    severity: 'warn' as const,
    code: 'interaction_dependent',
    message:
      `skill '${name}' works by asking questions and waiting; unattended it will invent ` +
      `the answers. Use --mode attended, or exclude it.`,
  }));
}

/**
 * Claude Code exposes `commands/<ns>/<cmd>.md` as the namespaced slash command `/<ns>:<cmd>`
 * (spec §2/§9: out of scope, alongside MCP servers and subagents). `build.ts`'s `markdownFiles`
 * only reads `.md` files directly in `promptsDir`, so a namespaced command is silently dropped —
 * this turns that silence into a warning naming each skipped namespace, so a promoted workflow
 * that invokes one fails loudly and locally instead of remotely with no signal.
 */
export function checkNamespacedPrompts(namespacedDirs: string[]): PreflightFinding[] {
  return namespacedDirs.map((name) => ({
    severity: 'warn' as const,
    code: 'namespaced_prompt_skipped',
    message:
      `prompts/${name}/ holds namespaced command(s) (Claude Code's '/${name}:*'); ` +
      `only prompts directly in the prompts directory are promoted, so these are not included`,
  }));
}

/**
 * Account for every `--exclude-prompt`, in both directions.
 *
 * Excluding the entry is an **error**: the bundle would otherwise build happily and then fail as
 * `unknown_entry`, which names the symptom rather than the cause the user typed.
 *
 * An exclusion matching nothing is a **warning**, because that is what a typo looks like — and a
 * typo here fails in the worst way available, by shipping the very prompt the user asked to keep
 * out. Both directions are reported so an omission is never silent.
 */
export function checkExcludedPrompts(
  entry: string | undefined,
  requested: string[],
  actuallyExcluded: Set<string>,
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const name of requested) {
    if (entry !== undefined && name === entry) {
      findings.push({
        severity: 'error',
        code: 'entry_excluded',
        message:
          `--exclude-prompt '${name}' names the entry prompt, so the bundle would carry no entry; ` +
          `choose a different entry or drop the exclusion`,
      });
      continue;
    }
    if (actuallyExcluded.has(name)) {
      findings.push({
        severity: 'warn',
        code: 'prompt_excluded',
        message: `prompt '${name}' was excluded by --exclude-prompt and is not in the bundle`,
      });
    } else {
      findings.push({
        severity: 'warn',
        code: 'prompt_exclude_unmatched',
        message:
          `--exclude-prompt '${name}' matched no prompt, so nothing was excluded for it ` +
          `(check the spelling: an unmatched exclusion ships the prompt you meant to omit)`,
      });
    }
  }
  return findings;
}

export function hasErrors(findings: PreflightFinding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

/** Human-readable report. Always states its own limits — spec §4.6 forbids implying completeness. */
export function renderPreflight(findings: PreflightFinding[]): string {
  const lines: string[] = [];
  if (findings.length === 0) {
    lines.push('preflight: no findings');
  } else {
    for (const severity of ['error', 'warn', 'info'] as const) {
      const group = findings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;
      lines.push(`${severity} (${group.length}):`);
      for (const f of group) {
        lines.push(`  [${f.code}] ${f.message}${f.path ? `  (${f.path})` : ''}`);
      }
    }
  }
  lines.push('');
  lines.push('Cannot be checked locally, and will only surface at run time:');
  lines.push(
    '  - a binary present in the sandbox but at a different version or with different flags',
  );
  lines.push('  - a tool present but lacking the credentials it needs');
  lines.push('  - network egress the sandbox denies');
  lines.push('  - a skill assuming host behavior that has no analogue and no mechanical signature');
  return lines.join('\n');
}
