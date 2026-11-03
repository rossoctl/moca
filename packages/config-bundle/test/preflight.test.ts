import { describe, it, expect } from 'vitest';
import {
  checkSiblingPaths,
  checkMemoryLinks,
  checkBinaries,
  checkEntry,
  checkInteraction,
  renderPreflight,
  hasErrors,
} from '../src/preflight.js';
import type { ResolvedSkill } from '../src/types.js';

const skill = (name: string, body: string, files: string[]): ResolvedSkill => ({
  name,
  dir: `/s/${name}`,
  skillMd: `---\nname: ${name}\n---\n${body}`,
  files: ['SKILL.md', ...files],
  scope: 'plugin',
});

describe('checkSiblingPaths', () => {
  it('is quiet when a referenced sibling is present', () => {
    const s = skill('brainstorming', 'read `skills/brainstorming/visual-companion.md`', [
      'visual-companion.md',
    ]);
    expect(checkSiblingPaths([s])).toEqual([]);
  });

  it('warns when a sibling under a directory the skill owns is absent', () => {
    // The skill ships references/guide.md, so it demonstrably owns references/ — a missing file
    // there is a real packaging gap. Warn, not error: preflight blocks only on facts.
    const s = skill('x', 'see `references/missing.md` for detail', ['references/guide.md']);
    const f = checkSiblingPaths([s]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.code).toBe('missing_sibling');
    expect(f[0]!.message).toContain('references/missing.md');
  });

  it('says the reference will not be in the bundle, not that it is misplaced (#628)', () => {
    // The shape the reporter hit: a repo-root `scripts/` beside skills that ship `scripts/*.py`.
    // `scripts/build.sh` DOES exist in their repo, so "not in its directory" read as a layout
    // mistake; the true statement is that only the skill's own directory travels, so the
    // reference will not resolve when the skill runs remotely.
    const s = skill('detect-missing-figures', 'run `scripts/build.sh` first', [
      'scripts/detect_figures.py',
    ]);
    const f = checkSiblingPaths([s]);
    expect(f).toHaveLength(1);
    expect(f[0]!.code).toBe('missing_sibling');
    expect(f[0]!.message).toContain('scripts/build.sh');
    expect(f[0]!.message).toContain('is not included in the bundle');
    // The part that answers "but the file is right there": why it is absent.
    expect(f[0]!.message).toContain("only files under the skill's own directory travel");
  });

  it('treats every ancestor directory as owned, not just the leaf parent', () => {
    // A skill shipping only a nested file still owns the ancestor directory.
    const nested = skill('x', 'see `references/missing.md`', ['references/deep/x.md']);
    expect(checkSiblingPaths([nested])).toHaveLength(1);
    // And symmetrically: shipping a shallow file means it owns the dir for a deep reference too.
    const shallow = skill('y', 'see `references/deep/missing.md`', ['references/guide.md']);
    expect(checkSiblingPaths([shallow])).toHaveLength(1);
    // Prefix matching stays EXACT — a sibling directory must not satisfy it.
    const neighbour = skill('z', 'see `references/missing.md`', ['references-old/g.md']);
    expect(checkSiblingPaths([neighbour])).toEqual([]);
  });

  it('ignores paths the skill does not own, which is what prose is full of', () => {
    // Measured: without these two exclusions the check fired 182 times across 28 real skills.
    const bare = skill('x', 'create `main.py` and `requirements.txt` yourself', [
      'references/g.md',
    ]);
    expect(checkSiblingPaths([bare])).toEqual([]);
    const unowned = skill('y', 'see `src/server.ts` in your project', ['references/g.md']);
    expect(checkSiblingPaths([unowned])).toEqual([]);
    const code = skill('z', 'call `window.open` and read `sys.path`', ['references/g.md']);
    expect(checkSiblingPaths([code])).toEqual([]);
  });

  it('ignores URLs and non-file-looking backticks', () => {
    const s = skill('x', 'see `https://e.com/a.md` and `--flag` and `some text`', []);
    expect(checkSiblingPaths([s])).toEqual([]);
  });

  it('ignores version numbers, IPs, semver ranges, and globs', () => {
    const s = skill(
      'x',
      'see `1.2.3` and `127.0.0.1` and `node>=18.0` and `*.md` in backticks',
      [],
    );
    expect(checkSiblingPaths([s])).toEqual([]);
  });

  it('still warns on genuinely missing owned files when filtering out false positives', () => {
    // The skill owns references/ (it ships references/guide.md), so references/missing.md is a
    // real gap even alongside version numbers and IPs that must NOT be mistaken for paths.
    const s = skill(
      'x',
      'see `1.2.3` version and `references/missing.md` file and `127.0.0.1` IP',
      ['references/guide.md'],
    );
    const f = checkSiblingPaths([s]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.message).toContain('references/missing.md');
  });
});

describe('checkMemoryLinks', () => {
  it('is quiet when every [[link]] resolves to an included memory file', () => {
    expect(checkMemoryLinks('see [[alpha]] and [[beta]]', ['alpha.md', 'beta.md'])).toEqual([]);
  });

  it('warns for a dangling link', () => {
    const f = checkMemoryLinks('see [[gone]]', ['alpha.md']);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.code).toBe('dangling_memory_link');
  });

  it('is quiet when there is no memory index at all', () => {
    expect(checkMemoryLinks(undefined, [])).toEqual([]);
  });

  it('handles markdown links [Title](file.md) when file is present', () => {
    expect(checkMemoryLinks('- [Alpha](alpha.md) — reference', ['alpha.md'])).toEqual([]);
  });

  it('warns for dangling markdown links', () => {
    const f = checkMemoryLinks('- [Missing](alpha.md)', ['beta.md']);
    expect(f).toHaveLength(1);
    expect(f[0]!.code).toBe('dangling_memory_link');
  });

  it('handles wikilinks with |alias suffix', () => {
    expect(checkMemoryLinks('see [[alpha|Alpha Notes]] in the docs', ['alpha.md'])).toEqual([]);
  });

  it('handles wikilinks with path prefix', () => {
    expect(
      checkMemoryLinks('see [[notes/alpha]] and [[beta]] in memory', ['alpha.md', 'beta.md']),
    ).toEqual([]);
  });

  it('mixes markdown and wikilinks', () => {
    const index = '- [Alpha](alpha.md)\n- [[beta|Beta Title]]\n- [[notes/gamma]]';
    expect(checkMemoryLinks(index, ['alpha.md', 'beta.md', 'gamma.md'])).toEqual([]);
  });

  it('warns for any dangling form in a mixed index', () => {
    const index = '- [Alpha](alpha.md)\n- [[gone]]';
    const f = checkMemoryLinks(index, ['alpha.md']);
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain('gone');
  });

  it('ignores external URLs in markdown links', () => {
    expect(checkMemoryLinks('[doc](https://example.com/file.md)', [])).toEqual([]);
  });

  it('ignores relative paths outside memory in markdown links', () => {
    expect(checkMemoryLinks('[x](../elsewhere/x.md)', ['alpha.md'])).toEqual([]);
  });

  it('still catches dangling local markdown links after filtering non-local', () => {
    // Present: should be quiet
    expect(checkMemoryLinks('[t](alpha.md)', ['alpha.md'])).toEqual([]);
    // Absent: should warn
    const f = checkMemoryLinks('[t](alpha.md)', ['beta.md']);
    expect(f).toHaveLength(1);
    expect(f[0]!.code).toBe('dangling_memory_link');
  });

  it('ignores wikilinks with .. path segments', () => {
    expect(checkMemoryLinks('see [[../outside/x]] in backlinks', ['alpha.md'])).toEqual([]);
  });
});

describe('checkBinaries', () => {
  it('warns, and never errors, for a binary absent from the sandbox inventory', () => {
    const f = checkBinaries(['gh', 'kubectl'], ['kubectl']);
    expect(f).toHaveLength(1);
    expect(f[0]!.code).toBe('missing_binary');
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.message).toContain('gh');
  });

  it('is quiet when every binary is present', () => {
    expect(checkBinaries(['gh'], ['gh', 'kubectl'])).toEqual([]);
  });

  it('warns (not errors) when no inventory is available to check against', () => {
    const f = checkBinaries(['gh'], undefined);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.code).toBe('inventory_unavailable');
  });
});

describe('checkEntry', () => {
  it('errors when the entry prompt is not in the bundle', () => {
    expect(checkEntry('nope', ['a', 'b'])[0]!.code).toBe('unknown_entry');
  });
  it('is quiet when it is', () => {
    expect(checkEntry('a', ['a'])).toEqual([]);
  });
});

describe('checkInteraction', () => {
  it('warns for each interaction-dependent skill', () => {
    const f = checkInteraction({
      travels: [],
      dropped: [],
      interactionDependent: ['superpowers:brainstorming'],
    });
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.code).toBe('interaction_dependent');
  });
});

describe('renderPreflight / hasErrors', () => {
  it('hasErrors is true only when a finding is an error', () => {
    expect(hasErrors([{ severity: 'warn', code: 'w', message: 'm' }])).toBe(false);
    expect(hasErrors([{ severity: 'error', code: 'e', message: 'm' }])).toBe(true);
  });

  it('renders findings grouped by severity, and states its own limits', () => {
    const out = renderPreflight([
      { severity: 'error', code: 'missing_binary', message: 'gh missing' },
      { severity: 'warn', code: 'interaction_dependent', message: 'brainstorming' },
    ]);
    expect(out).toContain('error');
    expect(out).toContain('gh missing');
    expect(out).toContain('warn');
    // The honesty requirement of spec §4.6: never imply completeness.
    expect(out.toLowerCase()).toContain('cannot be checked locally');
  });

  it('says so plainly when there is nothing to report', () => {
    expect(renderPreflight([]).toLowerCase()).toContain('no findings');
  });
});

describe('checkMemoryLinks ReDoS resistance', () => {
  // CodeQL flagged both link regexes as polynomial on uncontrolled data, and it was right:
  // measured on the unbounded forms, 40 KB of '[' took 2281 ms and 80 KB of '[[' took 9186 ms
  // -- input doubled, time QUADRUPLED. Bounded, the same inputs took 33 ms and 62 ms: input
  // doubled, time doubled. A crafted MEMORY.md in a third-party plugin skill would otherwise
  // hang the promote CLI for minutes.
  //
  // It used to assert that shape by TIMING, and both timing forms it has had failed in CI.
  // First a wall-clock budget of 1500 ms per input, which failed at 1624 ms. Then a RATIO --
  // time 2x the input, require under 3x the time -- on the reasoning that contention slows
  // both measurements and so cancels to first order. It does not. `make test` runs seven
  // workspaces in parallel on a two-core runner, and interference there is additive per unit
  // of wall clock, so the LONGER measurement absorbs more of it and the ratio is inflated
  // rather than cancelled. Reproduced under 2x CPU oversubscription: the nested shape's small
  // input still reached its true 10.6 ms floor in 4 of 9 samples, while its large input never
  // got below 32.8 ms against a true 20.3 ms -- ratios of 3.09 (min/min) through 8.33 (worst)
  // against a limit of 3. More samples cannot fix that, because there is no uncontended
  // window of the longer length to find. Nor can the limit be raised: two consecutive CI runs
  // of the same commit failed at 3.11 on one shape and 5.64 on another, and 5.64 is ABOVE the
  // ~4x that marks the quadratic form the limit exists to sit below -- so on that runner the
  // measurement cannot tell a ReDoS regression from a busy neighbour at any threshold. Idle,
  // every shape measures 2.00x. The signal is real; a wall clock on a shared two-core runner
  // is not an instrument that can see it.
  //
  // So the property is pinned where it actually comes from: the BOUND on each quantifier.
  // Unbound any of them to reintroduce the quadratic rescan and these fail immediately, with
  // no clock involved. The caps mirror src/preflight.ts.
  const TITLE_CAP = 300;
  const TARGET_CAP = 500;
  const dangling = (index: string): number =>
    checkMemoryLinks(index, ['included.md']).filter((f) => f.code === 'dangling_memory_link')
      .length;

  it('matches a markdown link whose title and target sit at the cap', () => {
    // The bound must not be so tight that it stops seeing real links. This is the other
    // half of the claim: at the cap the link is still found.
    expect(dangling(`[${'a'.repeat(TITLE_CAP)}](missing.md)`)).toBe(1);
    expect(dangling(`[T](${'b'.repeat(TARGET_CAP - 3)}.md)`)).toBe(1);
  });

  it('stops scanning a markdown link past the cap, rather than rescanning from every "["', () => {
    // Unbounded `[^\]]+` / `[^)]+` match these; `{1,300}` / `{1,500}` cannot. Skipping a
    // pathological link is the deliberate cost of the fix -- real memory links are far
    // inside these bounds -- and it is the observable, clock-free signature of the bound.
    expect(dangling(`[${'a'.repeat(TITLE_CAP + 1)}](missing.md)`)).toBe(0);
    expect(dangling(`[T](${'b'.repeat(TARGET_CAP + 1)}.md)`)).toBe(0);
  });

  it('stops scanning a wikilink past the cap', () => {
    expect(dangling(`[[${'a'.repeat(TITLE_CAP)}]]`)).toBe(1);
    expect(dangling(`[[${'a'.repeat(TITLE_CAP + 1)}]]`)).toBe(0);
  });

  it('does not let a link span a newline', () => {
    // The `\n` exclusion is the second half of the bound: without it a single unterminated
    // '[' can consume the rest of the file before failing, which is the quadratic input.
    expect(dangling('[a\nb](missing.md)')).toBe(0);
    expect(dangling('[[a\nb]]')).toBe(0);
  });

  it('does not hang on adversarial bracket runs', () => {
    // The one surviving timing assertion, and deliberately not a measurement: a backstop
    // against a true hang. 30 s against a real cost of ~130 ms is a 200x margin, so no
    // plausible amount of runner contention reaches it -- unlike a 3x ratio.
    const ABSOLUTE_CEILING_MS = 30_000;
    const adversarial = ['['.repeat(40_000), '[['.repeat(40_000), '[](' + '[(](('.repeat(16_000)];
    const t = performance.now();
    for (const evil of adversarial) checkMemoryLinks(evil, ['included.md']);
    expect(performance.now() - t).toBeLessThan(ABSOLUTE_CEILING_MS);
  });
});
