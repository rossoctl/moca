import { describe, expect, it } from 'vitest';
import { USAGE } from '../src/cli.js';
import { commandUsage } from '../src/core/usage.js';
import { SBX_USAGE } from '../src/sbx/cli.js';

/**
 * Every command line of a usage text must be reachable through `COMMAND --help` (#599 review): the
 * parser cuts entries at group headings (a non-indented line ending in `:` before a command line),
 * so a note line written that way would silently drop the command under it from its own help.
 */
function commandLines(usage: string, head: string): string[] {
  return usage.split('\n').filter((l) => l.startsWith(head));
}

/** A head line's command words, as typed for `COMMAND --help` (`credentials [list]`). */
function typed(line: string, head: string): string[] {
  const words: string[] = [];
  for (const w of line.slice(head.length).split(/ {2,}/)[0]!.split(' ')) {
    const word = /^\[([a-z][a-z+|-]*)\]$/.exec(w)?.[1] ?? w;
    if (!/^[a-z][a-z+|-]*$/.test(word)) break;
    words.push(word.split('|')[0]!);
  }
  return words;
}

describe('every command line is in its own COMMAND --help', () => {
  for (const [name, usage, head] of [
    ['mocactl', USAGE, '  mocactl '],
    ['mocactl sbx', SBX_USAGE, '  mocactl sbx '],
  ] as const) {
    it(`${name}: no command line is dropped by the entry parser`, () => {
      const lines = commandLines(usage, head);
      expect(lines.length).toBeGreaterThan(5);
      // A line with no command words (`mocactl --version`) is the bare command's, not a COMMAND's.
      const missing = lines.filter(
        (line) =>
          typed(line, head).length > 0 &&
          !(commandUsage(usage, head, typed(line, head)) ?? '').split('\n').includes(line),
      );
      expect(missing).toEqual([]);
    });
  }

  it('would catch a note that ends the entries early', () => {
    // The parser stops at the first non-indented line that is not a heading (the notes): a note
    // written mid-list drops every command below it, which the check above then reports.
    const lines = SBX_USAGE.split('\n');
    const at = lines.findIndex((l) => l.startsWith('  mocactl sbx ls'));
    const broken = [...lines.slice(0, at), 'a note mid-list', ...lines.slice(at)].join('\n');
    const head = '  mocactl sbx ';
    const missing = commandLines(broken, head).filter(
      (line) =>
        typed(line, head).length > 0 &&
        !(commandUsage(broken, head, typed(line, head)) ?? '').split('\n').includes(line),
    );
    expect(missing.length).toBeGreaterThan(0);
  });
});
