import { describe, expect, it } from 'vitest';
import { USAGE, usageFor } from '../src/cli.js';
import { usageEntries } from '../src/core/usage.js';
import { SBX_USAGE } from '../src/sbx/cli.js';

/**
 * Every flag an entry's syntax names is explained in that entry's own description (#875):
 * `COMMAND --help` shows only the command's entry (#867), so a flag explained under another
 * command, or nowhere, is a flag the user has to guess at. `--json` is explained once, in each
 * usage text's footer, and is the only flag an entry need not name; a head line that exists for one
 * required flag (formFlag) is described by its whole description.
 */
const EXPLAINED_IN_FOOTER = new Set(['--json']);

/**
 * An entry's line, split at its description column: a head line (`  mocactl sbx ...`) or a wrapped
 * syntax line (`      [--endpoint URL] ...`) is syntax up to its first run of two or more spaces
 * after text, and description after it; any other line is all description.
 */
function split(line: string, head: string): { syntax: string; description: string } {
  const isSyntax = line.startsWith(head) || /^\s+\[/.test(line);
  if (!isSyntax) return { syntax: '', description: line };
  const m = /^(\s*\S.*?\S) {2,}(\S.*)$/.exec(line);
  return m ? { syntax: m[1]!, description: m[2]! } : { syntax: line, description: '' };
}

const flagsIn = (text: string): string[] =>
  (text.match(/--[a-z][a-z-]*/g) ?? []).filter((f) => !EXPLAINED_IN_FOOTER.has(f));

/** `text` with its `[...]` groups, nested ones included, taken out: what is required. */
function required(text: string): string {
  let t = text;
  for (let prev = ''; prev !== t;) [prev, t] = [t, t.replace(/\[[^[\]]*\]/g, '')];
  return t;
}

/**
 * The form a head line exists for: a head that names one flag, and requires it
 * (`run "prompt" --show-tools`, `mocactl --version`), is that flag's own entry, and its whole
 * description is about it.
 */
function formFlag(syntax: string): string | undefined {
  const flags = flagsIn(syntax);
  return flags.length === 1 && flagsIn(required(syntax)).length === 1 ? flags[0] : undefined;
}

/** Each entry's flags its syntax names and its description does not, by the entry's first line. */
function unexplained(usage: string, head: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of usageEntries(usage, head)) {
    const parts = entry.lines.map((l) => ({ ...split(l, head), isHead: l.startsWith(head) }));
    const description = parts.map((p) => p.description).join(' ');
    const said = new Set(flagsIn(description));
    for (const p of parts) {
      const f = p.isHead ? formFlag(p.syntax) : undefined;
      if (f) said.add(f);
    }
    const missing = [...new Set(parts.flatMap((p) => flagsIn(p.syntax)))].filter(
      (f) => !said.has(f),
    );
    if (missing.length) out[entry.lines[0]!.trim().split(/ {2,}/)[0]!] = missing;
  }
  return out;
}

const TEXTS = [
  ['mocactl', USAGE, '  mocactl '],
  ['mocactl sbx', SBX_USAGE, '  mocactl sbx '],
] as const;

describe('every flag is explained in its own usage entry (#875)', () => {
  for (const [name, usage, head] of TEXTS) {
    it(`${name}: no entry names a flag its description does not`, () => {
      expect(usageEntries(usage, head).length).toBeGreaterThan(5);
      expect(unexplained(usage, head)).toEqual({});
    });

    it(`${name}: --json is explained once, after the commands`, () => {
      const notes = usage.split('\n').filter((l) => !l.startsWith(' '));
      expect(notes.filter((l) => l.startsWith('--json:'))).toHaveLength(1);
    });
  }

  it('mocactl COMMAND --help notes --json only for a command that takes it', () => {
    expect(usageFor(['doctor'])).toMatch(/^--json: /m);
    expect(usageFor(['login'])).not.toMatch(/^--json: /m);
    expect(usageFor(['login'])).toMatch(/^flags for every command: /m);
  });

  it('would catch a flag left out of its description', () => {
    const broken = SBX_USAGE.replace(
      '  mocactl sbx ls [--all] [--include-deleted] [--json]',
      '  mocactl sbx ls [--all] [--include-deleted] [--frobnicate] [--json]',
    );
    expect(unexplained(broken, '  mocactl sbx ')).toEqual({
      'mocactl sbx ls [--all] [--include-deleted] [--frobnicate] [--json]': ['--frobnicate'],
    });
  });
});
