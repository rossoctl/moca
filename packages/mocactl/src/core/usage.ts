import { parseArgs, type ParseArgsConfig } from 'node:util';

/**
 * `COMMAND [SUB...] --help`: the entries of a usage text for the command typed, rather than every
 * command's. Cut from the same text as the full `--help`, so the two never disagree.
 */

/**
 * One entry: its head line(s) (`  mocactl sbx ...`) and the indented lines under them. Consecutive
 * heads of one command with no description between them share the one after
 * (`templates quota`'s two forms, `admin subjects grant` and `revoke`).
 */
export interface UsageEntry {
  lines: string[];
  /** Each head's command words: `admin subjects enroll|unenroll SUBJECT` gives the first three. */
  heads: string[][];
  described: boolean;
}

/** A line that reaches the description column: text, a run of spaces, text. */
const DESCRIBED = /\S {2,}\S/;

/**
 * The words before the first flag, placeholder or quote: `templates create`, `proc logs`. A
 * bracketed word is an optional subcommand and counts (`proc [list]` would give `proc list`), so
 * `proc list --help` finds that entry alone; `a|b` names one subcommand twice (`credentials
 * ls|list`), and either word finds it (wordMatches).
 */
function headWords(head: string): string[] {
  const words: string[] = [];
  for (const w of head.split(/ {2,}/)[0]!.split(' ')) {
    const word = /^\[([a-z][a-z+|-]*)\]$/.exec(w)?.[1] ?? w;
    if (!/^[a-z][a-z+|-]*$/.test(word)) break;
    words.push(word);
  }
  return words;
}

/**
 * The entries under `usage`'s first line, up to its first line that is not indented (the notes). A
 * line that is not indented, ends in `:` and is followed by a head is a group heading (`sbx --help`
 * groups its commands, #599), and so is the blank line before one: they end the entry before them
 * and are in none. This applies to every usage text passed here, so a usage text must not put a
 * note line that ends in `:` directly before a command line, or it is read as a heading; the notes
 * go after the last command (the first other non-indented line ends the entries).
 */
export function usageEntries(usage: string, head: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  let cur: UsageEntry | undefined;
  const lines = usage.split('\n').slice(1);
  const heading = (i: number): boolean =>
    lines[i]?.endsWith(':') === true && lines[i + 1]?.startsWith(head) === true;
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith(' ')) {
      if (heading(i) || (line === '' && heading(i + 1))) {
        cur = undefined;
        continue;
      }
      break;
    }
    if (line.startsWith(head)) {
      const words = headWords(line.slice(head.length));
      const shares = cur && !cur.described && cur.heads.some((h) => h[0] === words[0]);
      if (!shares) entries.push((cur = { lines: [], heads: [], described: false }));
      cur!.lines.push(line);
      cur!.heads.push(words);
      if (DESCRIBED.test(line.slice(head.length))) cur!.described = true;
    } else if (cur) {
      // A wrapped head (more flags, `[...]`) describes it only if it reaches the description column.
      if (!/^\s+\[/.test(line) || DESCRIBED.test(line.trim())) cur.described = true;
      cur.lines.push(line);
    }
  }
  return entries;
}

const wordMatches = (head: string, typed: string): boolean => head.split('|').includes(typed);

/**
 * The entries of `usage` (whose head lines start with `head`) for the command `words` names,
 * narrowed by as many of the words as some entry has: `templates` gives every templates entry,
 * `templates create` only its own; a word no entry has (a prompt, an id) narrows nothing.
 * Undefined when no entry's command is `words[0]`: the caller then shows the whole usage.
 */
export function commandUsage(usage: string, head: string, words: string[]): string | undefined {
  const entries = usageEntries(usage, head);
  let found: UsageEntry[] = [];
  for (let n = 1; n <= words.length; n++) {
    const m = entries.filter((e) =>
      e.heads.some(
        (h) => h.length >= n && words.slice(0, n).every((w, i) => wordMatches(h[i]!, w)),
      ),
    );
    if (m.length === 0) break;
    found = m;
  }
  return found.length ? found.flatMap((e) => e.lines).join('\n') : undefined;
}

/**
 * The words typed before any `--`, by a parse that never fails: an unknown flag (`--jsn`) is taken
 * as a boolean, so a usage error still knows which command it is about. String flags keep their
 * values, so `--sandbox ID` is not taken for a word.
 */
export function typedWords(argv: string[], options: ParseArgsConfig['options']): string[] {
  try {
    const { positionals, tokens } = parseArgs({
      args: argv,
      options,
      strict: false,
      allowPositionals: true,
      tokens: true,
    });
    const dash = tokens.find((t) => t.kind === 'option-terminator');
    return dash
      ? positionals.slice(0, positionals.length - (argv.length - dash.index - 1))
      : positionals;
  } catch {
    return [];
  }
}
