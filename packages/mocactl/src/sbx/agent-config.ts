import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { sandboxRules, WORKSPACE, type SandboxModeName } from '@moca/sandbox-client';
import { sbxDirProblem } from './state.js';
import { parse, parseTree, ParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import {
  append,
  commentsOf,
  innerOf,
  remove,
  slotOf,
  styleOf,
  type Slot,
  type Style,
} from './json-edit.js';

/**
 * The agent configuration `sbx up` writes (SBX0 spec §6.3): Claude Code, OpenCode and IBM Bob
 * pointed at the sandbox MCP server, with every local built-in tool that would act on the laptop
 * denied — except Bob's, which has no deny mechanism to use (see BOB_SERVER).
 *
 * It is MERGED into what the developer has and never overwrites: a key is added, an array item
 * appended, a Markdown block put between markers; a value already there that disagrees stops
 * `sbx up` (a `ConfigConflict` naming the file and key). JSON is edited in place (json-edit.ts), so
 * the file keeps its indentation, key order, line endings and, in OpenCode's JSONC, its comments;
 * removal undoes an insertion byte for byte.
 * Every write is atomic (a temp file, then a rename) and keeps the file's mode.
 *
 * What was added is recorded in `.sbx/agent-config.json`, so `removeAgentConfig` takes back exactly
 * that and never a value the developer had. The tool lists live here, in one place, because the
 * agents add tools: `sbx doctor` checks against these lists (`checkAgentConfig`), so the denied state
 * is checked, not assumed.
 */

/** Claude Code's built-ins that act on the laptop: denied (spec §6.3). */
export const CLAUDE_DENY: readonly string[] = Object.freeze([
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
  // Run local commands as Bash does, but are not covered by a `Bash` deny (#568).
  'Monitor',
  'PowerShell',
  'LSP',
  // Only names the running Claude Code knows: it warns at every start about a deny rule naming
  // no known tool (#568). The pre-2.0 tools (`MultiEdit`, `LS`, `NotebookRead`) are therefore not
  // here; `sbx doctor` fails a Claude Code older than CLAUDE_MIN_VERSION instead.
]);
/**
 * The names `CLAUDE_DENY` held until #572: the pre-2.0 tools. A repository configured before they
 * were dropped still lists all three, and each one costs a warning at every Claude Code start, so
 * `sbx up` takes back the ones it added itself (#574). They are not denies to add, only denies to
 * recognise, which is why they are a list of their own rather than a comment.
 */
export const CLAUDE_RETIRED: readonly string[] = Object.freeze(['MultiEdit', 'LS', 'NotebookRead']);
/**
 * The oldest Claude Code CLAUDE_DENY covers: older ones also have `MultiEdit`, `LS` and
 * `NotebookRead`. The unknown-name warning came in 2.1.166, and every name in the list is a
 * known tool there and since (2.1.304 checked: no warning, `PowerShell` included on macOS).
 */
export const CLAUDE_MIN_VERSION = '2.0.0';

/** Whether `version` (`2.1.304`, or `claude --version`'s whole line) is older than the floor. */
export function claudeTooOld(version: string): boolean {
  const parts = (v: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  const [have, min] = [parts(version), parts(CLAUDE_MIN_VERSION)];
  if (have.length !== 3) return false; // unreadable: not a reason to fail
  for (let i = 0; i < 3; i++) if (have[i] !== min[i]) return have[i]! < min[i]!;
  return false;
}
/** OpenCode's built-ins that act on the laptop: `tools.<t> = false` (spec §6.3). */
export const OPENCODE_OFF: readonly string[] = Object.freeze([
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
  // `patch`'s newer name in current OpenCode: switching off a tool an older one lacks is harmless.
  'apply_patch',
  'multiedit',
  // Loads SKILL.md files from the laptop's skill directories (~/.claude/skills and others) into the
  // session: laptop content the sandboxed agent should not see, as in a benchmark run.
  'skill',
]);
export const MARK_BEGIN = '<!-- sbx:begin -->';
export const MARK_END = '<!-- sbx:end -->';
/**
 * The CLAUDE.md / AGENTS.md block body (spec §6.3): the MCP server's own instructions under a
 * heading. Claude Code does not load this CLAUDE.md (the `Read` deny covers it), so what steers it
 * is the server's instructions; the block is the same text, for people and for OpenCode (#568).
 */
export const GH_TOKEN_STEERING =
  "GH_TOKEN in the sandbox is a placeholder that the host replaces with the user's token; never set, print or ask for a token.";
/**
 * The block body for a sandbox in `mode` (ruling P4-R11): a lease sandbox's agent is told what a
 * lease keeps, not that every call is a fresh VM. `up` writes the one for the sandbox's mode.
 */
export const rulesFor = (mode: SandboxModeName): string =>
  ['## Working in the MOCA sandbox', '', sandboxRules(WORKSPACE, mode), '', GH_TOKEN_STEERING].join(
    '\n',
  );
/** The per-exec block body: the server's own instructions (MCP_INSTRUCTIONS) under a heading. */
export const RULES = rulesFor('per-exec');
const MODES = ['per-exec', 'lease', 'lease+processes'] as const;
/** Every mode's block body, once: what `doctor` takes as up to date when the mode is unknown. */
const ALL_RULES = [...new Set(MODES.map(rulesFor))];

/** The server name in every file: Claude Code's tools are then `mcp__sandbox__*`. */
export const SERVER = 'sandbox';
export const CLAUDE_SERVER = Object.freeze({ command: 'mocactl', args: ['sbx', 'mcp'] });
export const OPENCODE_SERVER = Object.freeze({
  type: 'local',
  command: ['mocactl', 'sbx', 'mcp'],
  enabled: true,
});
export const CLAUDE_ALLOW = 'mcp__sandbox__*';
/**
 * IBM Bob's server, in its repository-scoped config. The shape is `.mcp.json`'s, but kept apart
 * from CLAUDE_SERVER so the two can diverge and a conflict can name Bob.
 *
 * Bob reads its MCP servers from the repository, so unlike Codex it needs no launcher: `up` merges
 * into its config like the other two. What it has no equivalent of is Claude Code's
 * `permissions.deny` — `--allowed-tools` only waives confirmation, so Bob's local tools stay
 * available and nothing here can take them away (#593's lesson, applied).
 */
export const BOB_SERVER = Object.freeze({ command: 'mocactl', args: ['sbx', 'mcp'] });

const MCP_JSON = '.mcp.json';
const SETTINGS = '.claude/settings.json';
/**
 * Bob's two config filenames, both written (#676).
 *
 * Which one Bob reads depends on its version, and the names moved under us: Bob 2.0.9
 * (`bob mcp add`, default scope `workspace`) writes `.bob/mcp.json` and ignores
 * `.bob/settings.json` entirely, while earlier Bob read `.bob/settings.json` at what its help then
 * called `project` scope. `up` cannot tell which is installed — it runs before Bob is necessarily
 * on `PATH`, and parsing `bob --version` would make agent config depend on the agent.
 *
 * So write both. Each is a two-key file naming the same server, the cost of the redundant one is a
 * few bytes, and `doctor` passes when either carries the server. Writing only `settings.json` meant
 * `up` reported Bob configured while Bob saw no server at all: the symptom in #676, where
 * `bob mcp list` said "No MCP servers configured" against a file whose contents were correct.
 */
const BOB_SETTINGS = '.bob/settings.json';
const BOB_MCP = '.bob/mcp.json';
const SETTINGS_LOCAL = '.claude/settings.local.json';
const MANIFEST = '.sbx/agent-config.json';
const WRITE_HINT = 'edit it by hand, or run mocactl sbx up --no-agent-config';
/**
 * Claude Code's own wording for the option that accepts the server, so what we tell the user to
 * pick reads the same as what they see. Its prompt also offers "Use this and all future MCP
 * servers in this project", which works too; the highlighted default declines (#577).
 */
export const CLAUDE_PROMPT_PICK = 'Use this MCP server';
/** For an edit this module could not make safely: nothing was written. */
const EDIT_HINT =
  'nothing was changed; edit it by hand (and please report it), or use --no-agent-config / --keep-config';

export class ConfigConflict extends Error {
  constructor(
    readonly file: string,
    readonly key: string,
    why: string,
    hint: string = WRITE_HINT,
  ) {
    super(`${key === file ? file : `${file}: ${key}`} ${why}; ${hint}`);
    this.name = 'ConfigConflict';
  }
}

export interface AgentConfigResult {
  /** The files written (or, in a dry run, that would be), relative to the repository root. */
  changed: string[];
}

type Json = Record<string, unknown>;
type JsonPath = string[];

/** One thing `sbx up` added to a JSON file, so removal can take back exactly it. */
type JsonRec =
  | { file: string; op: 'key'; path: JsonPath; value: unknown }
  | { file: string; op: 'item'; path: JsonPath; value: unknown }
  | { file: string; op: 'container'; path: JsonPath }
  /** What was inside a container, empty, before the first append into it (restored on removal). */
  | { file: string; op: 'inner'; path: JsonPath; inner: string };
type MdRec =
  | { file: string; mode: 'created' }
  | { file: string; mode: 'appended'; before: string; after: string }
  | { file: string; mode: 'replaced'; previous: string };
interface Manifest {
  version: 1;
  /**
   * The repository is in Cortex mode (`sbx up --cortex`): Cortex's moca-sandbox script keeps the
   * agent off local tools, so Claude Code's local tools are not denied and its CLAUDE.md loads.
   * Absent in a record written before the mode existed, which is not in Cortex mode.
   */
  cortex?: true;
  /** Files `sbx up` created: deleted when nothing but its own content is left. */
  files: string[];
  /** Directories it created (`.claude`): removed when empty. */
  dirs: string[];
  json: JsonRec[];
  markdown: MdRec[];
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const emptyOrNone = (v: unknown) => v === undefined || (isObj(v) && Object.keys(v).length === 0);
const onlyKeys = (v: Json, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));

/** `mocactl sbx mcp` as Claude Code's server, written as ours or by hand (`type: stdio`, no env). */
function isClaudeServer(v: unknown): boolean {
  return (
    isObj(v) &&
    v.command === CLAUDE_SERVER.command &&
    same(v.args, CLAUDE_SERVER.args) &&
    (v.type === undefined || v.type === 'stdio') &&
    emptyOrNone(v.env) &&
    onlyKeys(v, ['command', 'args', 'type', 'env'])
  );
}

/** `mocactl sbx mcp` as IBM Bob's server: `.mcp.json`'s shape, plus Bob's own optional keys. */
function isBobServer(v: unknown): boolean {
  return (
    isObj(v) &&
    v.command === BOB_SERVER.command &&
    same(v.args, BOB_SERVER.args) &&
    (v.type === undefined || v.type === 'stdio') &&
    emptyOrNone(v.env) &&
    onlyKeys(v, ['command', 'args', 'type', 'env'])
  );
}

/** `mocactl sbx mcp` as OpenCode's server, enabled. */
function isOpencodeServer(v: unknown): boolean {
  return (
    isObj(v) &&
    v.type === 'local' &&
    same(v.command, OPENCODE_SERVER.command) &&
    (v.enabled === undefined || v.enabled === true) &&
    emptyOrNone(v.environment) &&
    onlyKeys(v, ['type', 'command', 'enabled', 'environment'])
  );
}

/** A Claude Code permission rule's tool: `Bash(npm test)` is `Bash`. */
const ruleTool = (r: unknown) => (typeof r === 'string' ? r.replace(/\(.*$/s, '').trim() : '');

// ---------------------------------------------------------------------------------------------
// Files

interface Target {
  /** Relative to the repository root, after following links. */
  rel: string;
  abs: string;
  exists: boolean;
}

/**
 * Where `rel` really is. A link is followed (CLAUDE.md is often a link to AGENTS.md) but only
 * within the repository: a link to a file outside it (a dotfiles settings.json) is refused, as is
 * a link to nothing.
 */
function target(root: string, rel: string, hint = WRITE_HINT): Target {
  const rroot = realpathSync(root);
  const abs = join(rroot, rel);
  let real: string;
  let exists = false;
  let linked = false;
  try {
    linked = lstatSync(abs).isSymbolicLink();
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    try {
      real = realpathSync(abs);
    } catch {
      throw new ConfigConflict(rel, rel, 'is a link to nothing', hint);
    }
    if (!statSync(real).isFile()) throw new ConfigConflict(rel, rel, 'is not a file', hint);
  } else {
    let dir = dirname(abs);
    const tail = [basename(abs)];
    while (!existsSync(dir) && dir !== rroot) {
      tail.unshift(basename(dir));
      dir = dirname(dir);
    }
    real = join(realpathSync(dir), ...tail);
  }
  if (!(real === rroot || real.startsWith(rroot + sep))) {
    throw new ConfigConflict(
      rel,
      rel,
      `is ${linked ? 'a link' : 'in a directory linked'} outside the repository`,
      hint,
    );
  }
  const resolved = relative(rroot, real).split(sep).join('/');
  // Inside the repository but in .git (a hook, the config): never a file sbx up edits, and a record
  // naming it would be malformed for good (#554 review).
  if (resolved === '.git' || resolved.startsWith('.git/')) {
    throw new ConfigConflict(rel, rel, 'is a link into .git', hint);
  }
  return { rel: resolved, abs: real, exists };
}

/** Atomic: a temp file beside it, renamed over it; the existing file's mode is kept. */
function writeAtomic(abs: string, body: string, mode?: number): void {
  const old = existsSync(abs) ? statSync(abs).mode & 0o7777 : undefined;
  const m = mode ?? old;
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, body, m !== undefined ? { mode: m } : {});
    if (m !== undefined) chmodSync(tmp, m); // the umask does not narrow the kept mode
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// JSON documents

interface Doc extends Target {
  text: string;
  data: Json;
  style: Style;
  jsonc: boolean;
  /** The text as read ('' for a file that does not exist yet). */
  original: string;
}

/** Parses JSON (or, for `jsonc`, JSON with comments and trailing commas, as OpenCode reads it). */
function parseDoc(text: string, jsonc: boolean): unknown {
  const r = diagnose(text, jsonc);
  return r.ok ? r.value : undefined;
}

/** The first key that appears twice in one object, as a dotted path (`mcpServers.sandbox`). */
function duplicateKey(text: string): string | undefined {
  const r = parseTree(text, [], { allowTrailingComma: true });
  const walk = (n: Node | undefined, path: string[]): string | undefined => {
    if (!n) return undefined;
    if (n.type === 'object') {
      const seen = new Set<string>();
      for (const p of n.children ?? []) {
        const k = String(p.children?.[0]?.value);
        if (seen.has(k)) return [...path, k].join('.');
        seen.add(k);
      }
      for (const p of n.children ?? []) {
        const d = walk(p.children?.[1], [...path, String(p.children?.[0]?.value)]);
        if (d) return d;
      }
    } else if (n.type === 'array') {
      for (const [i, c] of (n.children ?? []).entries()) {
        const d = walk(c, [...path, String(i)]);
        if (d) return d;
      }
    }
    return undefined;
  };
  return walk(r, []);
}

/**
 * The document's value, or why it cannot be merged into: each agent reads its file with a plain
 * JSON parser (or OpenCode's JSONC), where a duplicate key silently means the last one, so a
 * duplicate is refused rather than guessed at.
 */
function diagnose(
  text: string,
  jsonc: boolean,
): { ok: true; value: unknown } | { ok: false; key?: string; why: string } {
  if (text.charCodeAt(0) === 0xfeff) {
    return { ok: false, why: 'starts with a byte-order mark (save it as UTF-8 without one)' };
  }
  if (text.trim() === '') return { ok: false, why: 'is empty (it needs at least {})' };
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    disallowComments: !jsonc,
    allowTrailingComma: jsonc,
    allowEmptyContent: false,
  }) as unknown;
  if (errors.length) {
    const comments = !jsonc && errors.every((e) => e.error === ParseErrorCode.InvalidCommentToken);
    return {
      ok: false,
      why: comments
        ? 'has comments, which Claude Code does not read (it needs plain JSON)'
        : jsonc
          ? 'is not valid JSON (or JSONC)'
          : 'is not valid JSON',
    };
  }
  const dup = duplicateKey(text);
  if (dup !== undefined) {
    return { ok: false, key: dup, why: 'is a duplicate key (the agents would read only the last)' };
  }
  return { ok: true, value };
}

/** The document at `rel`, an empty one if missing; a file that is not a JSON object is refused. */
function loadDoc(root: string, rel: string, jsonc: boolean, hint = WRITE_HINT): Doc {
  const t = target(root, rel, hint);
  if (!t.exists) {
    return {
      ...t,
      text: '{}',
      data: {},
      style: styleOf(''),
      jsonc,
      original: '',
    };
  }
  const text = readFileSync(t.abs, 'utf8');
  const r = diagnose(text, jsonc);
  if (!r.ok) throw new ConfigConflict(t.rel, r.key ?? t.rel, r.why, hint);
  const v = r.value;
  if (!isObj(v)) throw new ConfigConflict(t.rel, t.rel, 'is not a JSON object', hint);
  return { ...t, text, data: v, style: styleOf(text), jsonc, original: text };
}

function at(data: unknown, path: (string | number)[]): unknown {
  let cur = data;
  for (const k of path) {
    if (typeof k === 'number') cur = Array.isArray(cur) ? cur[k] : undefined;
    else cur = isObj(cur) ? cur[k] : undefined;
  }
  return cur;
}

function edit(doc: Doc, f: (text: string) => string): void {
  let next: string;
  try {
    next = f(doc.text);
  } catch (err) {
    throw new ConfigConflict(
      doc.rel,
      doc.rel,
      `could not be edited (${(err as Error).message})`,
      EDIT_HINT,
    );
  }
  // Every edit is made here, on a document parsed here: one that no longer parses is refused
  // (nothing is written), never written out.
  const v = parseDoc(next, doc.jsonc);
  if (!isObj(v)) {
    throw new ConfigConflict(
      doc.rel,
      doc.rel,
      'could not be edited without breaking it',
      EDIT_HINT,
    );
  }
  doc.text = next;
  doc.data = v;
}

/** Sets `path` (which is absent) to `value`, creating the objects above it that are missing. */
function addKey(doc: Doc, path: JsonPath, value: unknown, recs: JsonRec[]): void {
  let i = path.length - 1;
  while (i > 0 && at(doc.data, path.slice(0, i)) === undefined) i--;
  let v = value;
  for (let j = path.length - 1; j > i; j--) v = { [path[j]!]: v };
  noteInner(doc, path.slice(0, i), recs);
  edit(doc, (t) => append(t, path.slice(0, i), path[i]!, v, doc.style));
  holds(doc, path, value);
}

/** Records an empty container's inside before the first append into it (`{ }`, `{\n}`). */
function noteInner(doc: Doc, path: JsonPath, recs: JsonRec[]): void {
  if (!doc.exists) return; // a file sbx creates is deleted, not restored
  const inner = innerOf(doc.text, path);
  if (inner !== undefined && inner !== '') recs.push({ file: doc.rel, op: 'inner', path, inner });
}

/**
 * The guard after every addition: the document, as an agent would parse it, holds `value` at
 * `path` (as the last item, for a list). An edit that parses but put the member somewhere else (in
 * a comment, say) is refused here, before anything is written.
 */
function holds(doc: Doc, path: JsonPath, value: unknown, item = false): void {
  const v = at(doc.data, path);
  const ok = item ? Array.isArray(v) && same(v[v.length - 1], value) : same(v, value);
  if (!ok) {
    throw new ConfigConflict(
      doc.rel,
      path.join('.'),
      'could not be edited safely (the new value would not be read where it was written)',
      EDIT_HINT,
    );
  }
}

function dropAt(doc: Doc, path: (string | number)[], recs: JsonRec[] = []): void {
  const parent = JSON.stringify(path.slice(0, -1));
  const r = recs.find((x) => x.op === 'inner' && JSON.stringify(x.path) === parent);
  const emptyInner = r?.op === 'inner' ? r.inner : '';
  const expected = without(doc.data, path);
  const comments = commentsOf(doc.text);
  const before = doc.text;
  const slot = slotOf(before, path);
  edit(doc, (t) => remove(t, path, { emptyInner }));
  // The guards on the rm side: the document, as an agent parses it, lost exactly that member and
  // nothing else; every comment in it is still there (sbx up never adds one); and the text is the
  // text before with only cuts made, all inside the member's slot (bar an emptied container's
  // recorded inside), so no byte the developer wrote outside it changed.
  if (!same(doc.data, expected)) {
    throw new ConfigConflict(
      doc.rel,
      path.join('.'),
      'needs a manual edit: removing it would have changed more than what sbx up added',
      RM_GUARD_HINT,
    );
  }
  const left = commentsOf(doc.text);
  const lost = comments.find(
    (c, i) =>
      comments.slice(0, i).filter((x) => x === c).length >= left.filter((x) => x === c).length,
  );
  if (lost !== undefined) {
    throw new ConfigConflict(
      doc.rel,
      path.join('.'),
      `needs a manual edit: removing it would have lost the comment ${JSON.stringify(lost.slice(0, 40))}`,
      RM_GUARD_HINT,
    );
  }
  if (!slot || !isCut(before, doc.text, slot, emptyInner)) {
    throw new ConfigConflict(
      doc.rel,
      path.join('.'),
      'needs a manual edit: removing it would have changed text around it, not only taken it out',
      RM_GUARD_HINT,
    );
  }
}

/**
 * Whether `after` is `before` with ranges deleted, all inside `slot` (from the end of the member
 * before to the start of the one after; json-edit's `slotOf`): the text outside the slot is the
 * same, and what is left of the slot is a subsequence of it. The one other shape allowed is an
 * emptied container's recorded inside (`emptyInner`) in place of all of the slot.
 */
function isCut(before: string, after: string, slot: Slot, emptyInner: string): boolean {
  const head = before.slice(0, slot.from);
  const tail = before.slice(slot.to);
  if (after.length < head.length + tail.length) return false;
  if (!after.startsWith(head) || !after.endsWith(tail)) return false;
  const left = after.slice(head.length, after.length - tail.length);
  if (slot.only && left === emptyInner) return true;
  const was = before.slice(slot.from, slot.to);
  let j = 0;
  for (let i = 0; i < was.length && j < left.length; i++) if (was[i] === left[j]) j++;
  return j === left.length && left.length < was.length;
}

/** `data` without the member at `path` (a deep copy; `data` is unchanged). */
function without(data: Json, path: (string | number)[]): Json {
  const copy = JSON.parse(JSON.stringify(data)) as Json;
  const parent = at(copy, path.slice(0, -1));
  const k = path[path.length - 1]!;
  if (Array.isArray(parent) && typeof k === 'number') parent.splice(k, 1);
  else if (isObj(parent) && typeof k === 'string') delete parent[k];
  return copy;
}

const RM_GUARD_HINT =
  'nothing was changed, and its record is kept in .sbx/agent-config.json: take back what sbx up ' +
  'added to it by hand, or keep it with mocactl sbx rm --keep-config';

/** Refuses a key on `path` whose value is there but not an object (it cannot be merged into). */
function needObjects(doc: Doc, path: JsonPath): void {
  for (let i = 1; i <= path.length; i++) {
    const v = at(doc.data, path.slice(0, i));
    if (v !== undefined && !isObj(v)) {
      throw new ConfigConflict(doc.rel, path.slice(0, i).join('.'), 'is there but not an object');
    }
  }
}

function needArray(doc: Doc, path: JsonPath): unknown[] {
  needObjects(doc, path.slice(0, -1));
  const v = at(doc.data, path);
  if (v !== undefined && !Array.isArray(v)) {
    throw new ConfigConflict(doc.rel, path.join('.'), 'is there but not a list');
  }
  return (v as unknown[] | undefined) ?? [];
}

/** Records every container on `path` that does not exist yet (it is created by the next edit). */
function recordMissing(doc: Doc, path: JsonPath, recs: JsonRec[]): void {
  for (let i = 1; i <= path.length; i++) {
    const p = path.slice(0, i);
    if (at(doc.data, p) === undefined) recs.push({ file: doc.rel, op: 'container', path: p });
  }
}

function setKey(doc: Doc, path: JsonPath, value: unknown, recs: JsonRec[]): void {
  recordMissing(doc, path.slice(0, -1), recs);
  addKey(doc, path, value, recs);
  recs.push({ file: doc.rel, op: 'key', path, value });
}

function addItems(doc: Doc, path: JsonPath, values: unknown[], recs: JsonRec[]): void {
  if (!values.length) return;
  if (at(doc.data, path) === undefined) {
    recordMissing(doc, path, recs);
    addKey(doc, path, values, recs);
  } else {
    noteInner(doc, path, recs);
    for (const v of values) {
      edit(doc, (t) => append(t, path, undefined, v, doc.style));
      holds(doc, path, v, true);
    }
  }
  for (const v of values) recs.push({ file: doc.rel, op: 'item', path, value: v });
}

/**
 * Takes back the `permissions.deny` items an earlier `up` recorded whose value `wanted` picks, and
 * returns their records so the merged record drops them. One the developer wrote is not recorded,
 * so it is never touched; one already gone by hand loses its record and nothing else.
 *
 * `soft` keeps a refused removal from failing the run: a `dropAt` guard refuses when taking the
 * member out would change text around it, and for a take-back that is a tidy-up rather than a
 * correctness fix (#574) the entry and its record are better left alone than the whole `up` failed.
 */
function dropDenies(
  doc: Doc,
  prev: Manifest | undefined,
  wanted: (value: unknown) => boolean,
  soft = false,
): JsonRec[] {
  const dropped = (prev?.json ?? []).filter(
    (r) =>
      r.op === 'item' &&
      r.file === doc.rel &&
      same(r.path, ['permissions', 'deny']) &&
      wanted(r.value),
  );
  for (const r of [...dropped]) {
    const arr = at(doc.data, r.path);
    if (!Array.isArray(arr)) continue;
    let i = arr.length - 1;
    while (i >= 0 && !same(arr[i], (r as { value: unknown }).value)) i--;
    if (i < 0) continue; // gone by hand: only its record is left to drop
    const was = { text: doc.text, data: doc.data };
    try {
      dropAt(doc, [...r.path, i], prev!.json);
    } catch (err) {
      if (!soft || !(err instanceof ConfigConflict)) throw err;
      doc.text = was.text;
      doc.data = was.data;
      dropped.splice(dropped.indexOf(r), 1);
    }
  }
  return dropped;
}

/** The doc's new text: a file created here ends with a newline. */
function finalText(doc: Doc): string {
  if (!doc.exists && !doc.text.endsWith(doc.style.eol)) return doc.text + doc.style.eol;
  return doc.text;
}

// ---------------------------------------------------------------------------------------------
// The files `up` merges into

/** OpenCode reads `opencode.json` or `opencode.jsonc`: the one the repository has (never both). */
function opencodeFile(root: string, hint = WRITE_HINT): string {
  const json = existsSync(join(root, 'opencode.json'));
  const jsonc = existsSync(join(root, 'opencode.jsonc'));
  if (json && jsonc) {
    throw new ConfigConflict(
      'opencode.json',
      'opencode.json',
      'and opencode.jsonc are both here, and it is not clear which OpenCode reads',
      hint,
    );
  }
  return jsonc ? 'opencode.jsonc' : 'opencode.json';
}

/** The OpenCode tools every check covers: the exact `tools` keys and the overrides alike. */
const OPENCODE_TOOLS: readonly string[] = OPENCODE_OFF;
/** The `permission` key that gates a tool: `edit` covers every file modification. */
const permissionOf = (t: string) => (['write', 'patch', 'apply_patch'].includes(t) ? 'edit' : t);
/** An OpenCode tool or permission key, which may hold `*` and `?` wildcards. */
const globMatch = (pattern: string, name: string) =>
  new RegExp(
    '^' +
      pattern
        .split('')
        .map((ch) =>
          ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&'),
        )
        .join('') +
      '$',
  ).test(name);

/**
 * Where an OpenCode config switches a local tool back on, as `key`s naming each place (review I2):
 * - a `tools` wildcard set to anything but `false` (the exact keys are `up`'s own, checked apart);
 * - `permission`, or an agent's: for each local tool, the last key matching it (OpenCode's last
 *   matching rule wins) when it is not `deny` (a granular rule set counts as `deny` only if every
 *   rule in it is); a bare string for the whole of `permission` that is not `deny`;
 * - `agent.<name>.tools.<pattern>` not `false` for a pattern matching a local tool.
 * In document order, each key once. Unknown value shapes count as re-enabling: erring wide only
 * stops `up` and names the key.
 */
export function opencodeReenables(data: Json | undefined): string[] {
  const out: string[] = [];
  const add = (k: string) => {
    if (!out.includes(k)) out.push(k);
  };
  const denies = (v: unknown) =>
    v === 'deny' ||
    (isObj(v) && Object.keys(v).length > 0 && Object.values(v).every((x) => x === 'deny'));
  const tools = (prefix: string, v: unknown, exactToo: boolean) => {
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (!exactToo && OPENCODE_TOOLS.includes(k)) continue;
      if (x !== false && OPENCODE_TOOLS.some((t) => globMatch(k, t))) add(`${prefix}.${k}`);
    }
  };
  const permission = (prefix: string, v: unknown) => {
    if (v === undefined) return;
    if (!isObj(v)) {
      if (v !== 'deny') add(prefix);
      return;
    }
    const keys = Object.keys(v);
    for (const t of OPENCODE_TOOLS) {
      const names = [t, permissionOf(t)];
      const last = [...keys].reverse().find((k) => names.some((n) => globMatch(k, n)));
      if (last !== undefined && !denies(v[last])) add(`${prefix}.${last}`);
    }
  };
  for (const [k, v] of Object.entries(data ?? {})) {
    if (k === 'tools') tools('tools', v, false);
    else if (k === 'permission') permission('permission', v);
    else if (k === 'agent' && isObj(v)) {
      for (const [name, a] of Object.entries(v)) {
        if (!isObj(a)) continue;
        for (const [ak, av] of Object.entries(a)) {
          if (ak === 'tools') tools(`agent.${name}.tools`, av, true);
          else if (ak === 'permission') permission(`agent.${name}.permission`, av);
        }
      }
    }
  }
  return out;
}

/** `disabledMcpjsonServers` naming the sandbox in a settings file: Claude Code then rejects it. */
function rejectsServer(data: Json | undefined): boolean {
  const d = data?.disabledMcpjsonServers;
  return Array.isArray(d) && d.includes(SERVER);
}

/** settings.local.json, read only (it is the developer's own): undefined when absent or unreadable. */
function readLocalSettings(root: string): Json | undefined {
  try {
    const t = target(root, SETTINGS_LOCAL);
    if (!t.exists) return undefined;
    const v = parseDoc(readFileSync(t.abs, 'utf8'), false);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

interface MdPlan {
  t: Target;
  before: string | undefined;
  after: string;
  rec?: MdRec;
}

/** The block, in the file's own line endings. */
const blockFor = (eol: string, rules = RULES) =>
  [MARK_BEGIN, ...rules.split('\n'), MARK_END].join(eol);

/** Where the markers are; refused unless there is no marker or exactly one well-ordered pair. */
function markers(rel: string, text: string, hint = WRITE_HINT): [number, number] | undefined {
  const count = (m: string) => text.split(m).length - 1;
  const nb = count(MARK_BEGIN);
  const ne = count(MARK_END);
  if (nb === 0 && ne === 0) return undefined;
  const b = text.indexOf(MARK_BEGIN);
  const e = text.indexOf(MARK_END);
  if (nb !== 1 || ne !== 1 || e < b) {
    throw new ConfigConflict(
      rel,
      `the ${MARK_BEGIN} … ${MARK_END} markers`,
      'are not one well-formed pair',
      hint,
    );
  }
  return [b, e + MARK_END.length];
}

function planMarkdown(root: string, rel: string, rules: string): MdPlan {
  const t = target(root, rel);
  if (!t.exists) {
    const after = `${blockFor('\n', rules)}\n`;
    return { t, before: undefined, after, rec: { file: t.rel, mode: 'created' } };
  }
  const text = readFileSync(t.abs, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = blockFor(eol, rules);
  const m = markers(t.rel, text);
  if (m) {
    const previous = text.slice(m[0], m[1]);
    if (previous === block) return { t, before: text, after: text };
    return {
      t,
      before: text,
      after: text.slice(0, m[0]) + block + text.slice(m[1]),
      rec: { file: t.rel, mode: 'replaced', previous },
    };
  }
  const lead = text === '' ? '' : text.endsWith(eol) ? eol : eol + eol;
  return {
    t,
    before: text,
    after: text + lead + block + eol,
    rec: { file: t.rel, mode: 'appended', before: lead, after: eol },
  };
}

/** The record: none, read, or there but unreadable (corrupt, or from another mocactl version). */
function loadManifest(root: string): { m?: Manifest; bad?: string } {
  const p = join(root, MANIFEST);
  if (!existsSync(p)) return {};
  let m: Partial<Manifest>;
  try {
    m = JSON.parse(readFileSync(p, 'utf8')) as Partial<Manifest>;
  } catch {
    return { bad: 'is not valid JSON' };
  }
  if (!isObj(m) || m.version !== 1) {
    return { bad: `is of an unknown version (${JSON.stringify(isObj(m) ? m.version : m)})` };
  }
  const bad = manifestProblem(m, recordable(root));
  return bad ? { bad } : { m: m as Manifest };
}

/** The JSON and Markdown files `sbx up` writes, and the directory it may create. */
const JSON_FILES = [MCP_JSON, SETTINGS, 'opencode.json', 'opencode.jsonc', BOB_SETTINGS, BOB_MCP];
const MD_FILES = ['CLAUDE.md', 'AGENTS.md'];
const DIRS = [dirname(SETTINGS), dirname(BOB_SETTINGS)];

/**
 * The files a record may name: the ones `sbx up` writes, and where each of them leads now if it
 * is a link inside the repository (a record holds the path written, after links). A forged or
 * stale entry naming any other file (`package.json`) is a malformed record, never edited.
 */
function recordable(root: string): { json: string[]; md: string[] } {
  const via = (names: string[]) =>
    uniq(
      names.flatMap((f) => {
        try {
          return [f, target(root, f).rel];
        } catch {
          return [f]; // a link outside, or to nothing: only its own name
        }
      }),
    );
  return { json: via(JSON_FILES), md: via(MD_FILES) };
}

/** A path inside the repository, as `sbx up` records one: relative, no `..`, no `.git`. */
const isRelPath = (v: unknown): v is string =>
  typeof v === 'string' &&
  v !== '' &&
  !v.startsWith('/') &&
  !v.includes('\\') &&
  v.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg !== '.git');
const isStr = (v: unknown): v is string => typeof v === 'string';
const isKeys = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** What is wrong with a version-1 record's shape, or undefined when every entry is well-formed. */
function manifestProblem(m: Json, ok: { json: string[]; md: string[] }): string | undefined {
  for (const k of ['files', 'dirs', 'json', 'markdown'] as const) {
    if (!Array.isArray(m[k])) return `has no ${k} list`;
  }
  const at = (what: string, i: number) => `has a malformed ${what} entry (#${i + 1})`;
  const one = (names: readonly string[]) => (v: unknown) => isRelPath(v) && names.includes(v);
  for (const [what, xs, allowed] of [
    ['files', m.files, [...ok.json, ...ok.md]],
    ['dirs', m.dirs, DIRS],
  ] as const) {
    const i = (xs as unknown[]).findIndex((x) => !one(allowed)(x));
    if (i >= 0) return at(what, i);
  }
  const jsonOk = (r: unknown): boolean => {
    if (!isObj(r) || !one(ok.json)(r.file) || !isKeys(r.path)) return false;
    switch (r.op) {
      // A key, a list or a container sbx up added names at least one key: [] is the document.
      case 'key':
      case 'item':
        return r.path.length > 0 && 'value' in r;
      case 'container':
        return r.path.length > 0;
      // The inside an empty container had: [] is the document's own, `{ }` (review round 2).
      case 'inner':
        // Only whitespace was ever inside an emptied container that up recorded (noteInner).
        return isStr(r.inner) && r.inner.trim() === '';
      default:
        return false;
    }
  };
  const ji = (m.json as unknown[]).findIndex((r) => !jsonOk(r));
  if (ji >= 0) return at('json', ji);
  const mdOk = (r: unknown): boolean => {
    if (!isObj(r) || !one(ok.md)(r.file)) return false;
    switch (r.mode) {
      case 'created':
        return true;
      case 'appended':
        return isStr(r.before) && isStr(r.after);
      case 'replaced':
        return isStr(r.previous);
      default:
        return false;
    }
  };
  const mi = (m.markdown as unknown[]).findIndex((r) => !mdOk(r));
  if (mi >= 0) return at('markdown', mi);
  if (m.cortex !== undefined && m.cortex !== true) return 'has a malformed cortex entry';
  return undefined;
}

const SBX_DIR_HINT =
  "it holds this laptop's binding and its record of what sbx up added, so neither is read from it: remove it from the repository (git rm -r --cached .sbx) or replace the link, then run the command again";

const BAD_RECORD_HINT =
  'it lists what sbx up added, so it was kept: fix or remove it by hand (taking back what it lists)';

const uniq = <T>(xs: T[]): T[] => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Merges the agent configuration into the repository at `root` (spec §6.3). Everything is read and
 * checked before anything is written, so a conflict in any file (a `ConfigConflict`) writes
 * nothing anywhere. `dryRun` checks and reports what would change, writing nothing: `sbx up` runs
 * it before it creates or pushes anything.
 */
export function writeAgentConfig(
  root: string,
  /** `mode`: the sandbox's, for the CLAUDE.md / AGENTS.md rules (default per-exec). */
  o: { dryRun?: boolean; cortex?: boolean; mode?: SandboxModeName } = {},
): AgentConfigResult {
  const sbxBad = sbxDirProblem(root);
  if (sbxBad) throw new ConfigConflict('.sbx', '.sbx', sbxBad, SBX_DIR_HINT);
  const recs: JsonRec[] = [];
  const created: string[] = [];
  const dirs: string[] = [];

  // Read and check every file first, the record included: one that cannot be read is never
  // written over, or what it lists could no longer be taken back.
  const { m: prev, bad } = loadManifest(root);
  if (bad) throw new ConfigConflict(MANIFEST, MANIFEST, bad, BAD_RECORD_HINT);
  // Cortex mode sticks: once a repository is in it, a plain `up` keeps it (spec §3 step 4).
  const cortex = o.cortex === true || prev?.cortex === true;
  const mcp = loadDoc(root, MCP_JSON, false);
  const settings = loadDoc(root, SETTINGS, false);
  const oc = loadDoc(root, opencodeFile(root), true);
  const bob = loadDoc(root, BOB_SETTINGS, false);
  const bobMcp = loadDoc(root, BOB_MCP, false);
  const local = readLocalSettings(root);

  needObjects(mcp, ['mcpServers']);
  const have = at(mcp.data, ['mcpServers', SERVER]);
  if (have !== undefined && !isClaudeServer(have)) {
    throw new ConfigConflict(mcp.rel, `mcpServers.${SERVER}`, 'is there and names another server');
  }

  needObjects(bob, ['mcpServers']);
  const bobHave = at(bob.data, ['mcpServers', SERVER]);
  if (bobHave !== undefined && !isBobServer(bobHave)) {
    throw new ConfigConflict(bob.rel, `mcpServers.${SERVER}`, 'is there and names another server');
  }

  needObjects(bobMcp, ['mcpServers']);
  const bobMcpHave = at(bobMcp.data, ['mcpServers', SERVER]);
  if (bobMcpHave !== undefined && !isBobServer(bobMcpHave)) {
    throw new ConfigConflict(
      bobMcp.rel,
      `mcpServers.${SERVER}`,
      'is there and names another server',
    );
  }

  needObjects(settings, ['permissions']);
  const allow = needArray(settings, ['permissions', 'allow']);
  const deny = needArray(settings, ['permissions', 'deny']);
  const enabled = needArray(settings, ['enabledMcpjsonServers']);
  const reenabled = allow.filter((a) => CLAUDE_DENY.includes(ruleTool(a)));
  if (reenabled.length) {
    throw new ConfigConflict(
      settings.rel,
      'permissions.allow',
      `lists local built-in tools (${reenabled.join(', ')}), which would act on this machine`,
    );
  }
  for (const [file, data] of [
    [settings.rel, settings.data],
    [SETTINGS_LOCAL, local],
  ] as const) {
    if (rejectsServer(data)) {
      throw new ConfigConflict(
        file,
        'disabledMcpjsonServers',
        `rejects the ${SERVER} MCP server, so Claude Code would have no tools`,
      );
    }
  }

  needObjects(oc, ['mcp']);
  needObjects(oc, ['tools']);
  const ocHave = at(oc.data, ['mcp', SERVER]);
  if (ocHave !== undefined && !isOpencodeServer(ocHave)) {
    throw new ConfigConflict(
      oc.rel,
      `mcp.${SERVER}`,
      'is there and is not an enabled mocactl sbx mcp',
    );
  }
  for (const t of OPENCODE_OFF) {
    const v = at(oc.data, ['tools', t]);
    if (v !== undefined && v !== false) {
      throw new ConfigConflict(
        oc.rel,
        `tools.${t}`,
        `is ${JSON.stringify(v)}: the local tool would act on this machine`,
      );
    }
  }
  const ocBack = opencodeReenables(oc.data)[0];
  if (ocBack !== undefined) {
    throw new ConfigConflict(
      oc.rel,
      ocBack,
      "switches a local built-in tool back on (OpenCode's agent and permission settings override " +
        'tools), which would act on this machine',
    );
  }

  // The Markdown files, once each (CLAUDE.md is often a link to AGENTS.md).
  const md: MdPlan[] = [];
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const t = target(root, f);
    if (md.some((p) => p.t.abs === t.abs)) continue;
    md.push(planMarkdown(root, f, rulesFor(o.mode ?? 'per-exec')));
  }

  // Then merge, in memory.
  if (have === undefined) setKey(mcp, ['mcpServers', SERVER], { ...CLAUDE_SERVER }, recs);
  if (bobHave === undefined) setKey(bob, ['mcpServers', SERVER], { ...BOB_SERVER }, recs);
  if (bobMcpHave === undefined) setKey(bobMcp, ['mcpServers', SERVER], { ...BOB_SERVER }, recs);
  addItems(
    settings,
    ['permissions', 'allow'],
    allow.includes(CLAUDE_ALLOW) ? [] : [CLAUDE_ALLOW],
    recs,
  );
  // In Cortex mode the local tools are not denied: Cortex blocks them, and a Read deny would stop
  // Claude Code loading CLAUDE.md (#568). Deny items an earlier `up` added are taken back; one
  // the developer wrote is not in the record, so it stays.
  let dropped: JsonRec[] = [];
  if (cortex) {
    dropped = dropDenies(settings, prev, () => true);
    // The list itself, when an earlier `up` created it and nothing is left in it.
    const made = (prev?.json ?? []).find(
      (r) =>
        r.op === 'container' && r.file === settings.rel && same(r.path, ['permissions', 'deny']),
    );
    const left = at(settings.data, ['permissions', 'deny']);
    if (made && Array.isArray(left) && left.length === 0) {
      dropAt(settings, ['permissions', 'deny'], prev!.json);
      dropped.push(made);
    }
  } else {
    addItems(
      settings,
      ['permissions', 'deny'],
      CLAUDE_DENY.filter((t) => !deny.includes(t)),
      recs,
    );
    // A repository configured before #572 still lists the pre-2.0 tools, and each one costs a
    // warning at every Claude Code start. The ones an earlier `up` added are taken back, after the
    // additions above so the list is never emptied here; one the developer wrote is not in the
    // record, so it stays (#574).
    dropped = dropDenies(settings, prev, (v) => CLAUDE_RETIRED.includes(ruleTool(v)), true);
  }
  addItems(settings, ['enabledMcpjsonServers'], enabled.includes(SERVER) ? [] : [SERVER], recs);
  if (ocHave === undefined) setKey(oc, ['mcp', SERVER], { ...OPENCODE_SERVER }, recs);
  for (const t of OPENCODE_OFF) {
    if (at(oc.data, ['tools', t]) === undefined) setKey(oc, ['tools', t], false, recs);
  }

  const writes: { t: Target; body: string }[] = [];
  // Once per real file, as the Markdown loop above: Bob's two filenames hold the same entry, so a
  // developer keeping them in step with a link (`ln -s settings.json .bob/mcp.json`) leaves two
  // Docs over one file. Both merge the same key into the same bytes and so agree, but considering
  // it twice would name it twice in what `up` prints and write it a second time for nothing.
  // Seen, not "already in writes": the first of the pair may be skipped as unchanged below.
  const seenDocs = new Set<string>();
  for (const d of [mcp, settings, oc, bob, bobMcp]) {
    if (seenDocs.has(d.abs)) continue;
    seenDocs.add(d.abs);
    const body = finalText(d);
    if (d.exists && body === d.original) continue;
    if (!d.exists && !recs.some((r) => r.file === d.rel)) continue;
    writes.push({ t: d, body });
    if (!d.exists) created.push(d.rel);
  }
  for (const p of md) {
    if (p.before === p.after) continue;
    writes.push({ t: p.t, body: p.after });
    if (!p.t.exists) created.push(p.t.rel);
  }
  // The nested files' directories, so `sbx rm` can remove one it created.
  for (const d of [settings, bob, bobMcp]) {
    if (d.exists || !writes.some((w) => w.t.rel === d.rel)) continue;
    const dir = dirname(d.rel);
    if (!existsSync(join(root, dir))) dirs.push(dir);
  }
  const changed = writes.map((w) => w.t.rel);
  const enteringCortex = cortex && prev?.cortex !== true;
  if (o.dryRun || (!writes.length && !enteringCortex)) return { changed };

  // The record first: if a write below fails, removal still knows what may have been added.
  const mdRecs = md.flatMap((p) => (p.rec ? [p.rec] : []));
  const merged: Manifest = {
    version: 1,
    ...(cortex ? { cortex: true as const } : {}),
    files: uniq([...(prev?.files ?? []), ...created]),
    dirs: uniq([...(prev?.dirs ?? []), ...dirs]),
    json: uniq([...(prev?.json ?? []).filter((r) => !dropped.includes(r)), ...recs]),
    // An earlier run's record of a file wins: it knows what was there before sbx touched it.
    markdown: [
      ...(prev?.markdown ?? []),
      ...mdRecs.filter((r) => !prev?.markdown.some((p) => p.file === r.file)),
    ],
  };
  mkdirSync(join(root, '.sbx'), { recursive: true });
  writeAtomic(join(root, MANIFEST), JSON.stringify(merged, null, 2) + '\n', 0o600);
  for (const w of writes) writeAtomic(w.t.abs, w.body);
  return { changed };
}

// ---------------------------------------------------------------------------------------------
// Removal

const RM_HINT = 'fix it by hand, then run mocactl sbx rm again (nothing was removed)';

/** Removes the block `sbx up` put in a Markdown file, restoring what it replaced. */
function unblock(text: string, rec: MdRec): string | { skipped: string } {
  let m: [number, number] | undefined;
  try {
    m = markers(rec.file, text, RM_HINT);
  } catch {
    // The developer has edited the markers since: the block is theirs now.
    return { skipped: `the ${MARK_BEGIN} … ${MARK_END} markers are not one pair any more` };
  }
  if (!m) return { skipped: 'the sandbox rules block is no longer there' };
  const [b, e] = m;
  if (rec.mode === 'replaced') return text.slice(0, b) + rec.previous + text.slice(e);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lead = rec.mode === 'appended' ? rec.before : '';
  const trail = rec.mode === 'appended' ? rec.after : eol;
  const start = lead && text.slice(b - lead.length, b) === lead ? b - lead.length : b;
  const end = text.slice(e, e + trail.length) === trail ? e + trail.length : e;
  return text.slice(0, start) + text.slice(end);
}

export interface TakeBack {
  /** The files changed back, or deleted. */
  removed: string[];
  /** What was left alone, and why: one line each, naming the file. */
  warnings: string[];
  /** The record could not be read, so it was kept (and `.sbx/` with it). */
  recordKept: boolean;
}

/**
 * Takes back exactly what `writeAgentConfig` added (`.sbx/agent-config.json`), and deletes the files
 * and directory it created when nothing else is left in them. A value the developer had, or added
 * since, is kept. Every file is read and checked before any is changed: one that is no longer
 * valid JSON, or that now links outside the repository, stops it (a `ConfigConflict`) with nothing
 * removed. A Markdown block whose markers were broken by hand is left alone, and named. A record
 * that cannot be read is kept, with a warning: deleting it would orphan what it lists.
 */
export function takeBackAgentConfig(root: string): TakeBack {
  const sbxBad = sbxDirProblem(root);
  if (sbxBad)
    return { removed: [], warnings: [`.sbx ${sbxBad}; ${SBX_DIR_HINT}`], recordKept: true };
  const { m, bad } = loadManifest(root);
  if (bad) {
    return { removed: [], warnings: [`${MANIFEST} ${bad}; ${BAD_RECORD_HINT}`], recordKept: true };
  }
  if (!m) return { removed: [], warnings: [], recordKept: false };
  const warnings: string[] = [];
  const files = uniq(m.json.map((r) => r.file));
  const docs: Doc[] = [];
  // A record names a file after following links (target()), so a linked opencode.json is recorded
  // as its target's path. Only OpenCode's is JSONC; the rest are strict JSON: decide by resolving.
  const strict = new Set<string>();
  for (const f of [MCP_JSON, SETTINGS, BOB_SETTINGS, BOB_MCP]) {
    try {
      strict.add(target(root, f, RM_HINT).rel);
    } catch {
      strict.add(f); // a link out of the repository: its record was refused by the allow-list
    }
  }
  for (const f of files) {
    if (!existsSync(join(root, f))) continue;
    docs.push(loadDoc(root, f, !strict.has(f), RM_HINT));
  }
  const touched: string[] = [];
  const writes: { abs: string; body?: string }[] = [];
  for (const d of docs) {
    const mine = m.json.filter((r) => r.file === d.rel);
    for (const r of mine) {
      if (r.op !== 'item') continue;
      const arr = at(d.data, r.path);
      if (!Array.isArray(arr)) continue;
      let i = arr.length - 1;
      while (i >= 0 && !same(arr[i], r.value)) i--;
      if (i >= 0) dropAt(d, [...r.path, i], mine);
    }
    for (const r of mine) {
      if (r.op === 'key' && same(at(d.data, r.path), r.value)) dropAt(d, r.path, mine);
    }
    const containers = mine
      .filter((r) => r.op === 'container')
      .sort((a, b) => b.path.length - a.path.length);
    for (const r of containers) {
      const v = at(d.data, r.path);
      const empty = Array.isArray(v) ? v.length === 0 : isObj(v) && Object.keys(v).length === 0;
      if (empty) dropAt(d, r.path, mine);
    }
    // A file sbx up created goes only when nothing but `{}` is left: a comment or anything else
    // the developer wrote there since is theirs, so the rest is written back, and that is said.
    const createdHere = m.files.includes(d.rel) && Object.keys(d.data).length === 0;
    if (createdHere && commentsOf(d.text).length === 0 && d.text.replace(/\s/g, '') === '{}') {
      writes.push({ abs: d.abs });
      touched.push(d.rel);
    } else if (createdHere) {
      warnings.push(
        `${d.rel}: kept: sbx up created it, but it holds text written since (a comment, say); ` +
          'what sbx up added is gone, the rest is as it was',
      );
      writes.push({ abs: d.abs, body: d.text });
      touched.push(d.rel);
    } else if (d.text !== d.original) {
      writes.push({ abs: d.abs, body: d.text });
      touched.push(d.rel);
    }
  }
  for (const r of m.markdown) {
    const t = target(root, r.file, RM_HINT);
    if (!t.exists) continue;
    const abs = t.abs;
    const text = readFileSync(abs, 'utf8');
    const out = unblock(text, r);
    if (typeof out !== 'string') {
      warnings.push(`${r.file}: skipped: ${out.skipped}; it was left as it is`);
      continue;
    }
    if (out === text) continue;
    if (r.mode === 'created' && out.trim() === '') writes.push({ abs });
    else writes.push({ abs, body: out });
    touched.push(r.file);
  }
  for (const w of writes) {
    try {
      if (w.body === undefined) rmSync(w.abs, { force: true });
      else writeAtomic(w.abs, w.body);
    } catch (err) {
      // Named, with the record kept: the files already done stay done, and a second rm finishes.
      const e = err as NodeJS.ErrnoException;
      throw new ConfigConflict(
        relative(realpathSync(root), w.abs).split(sep).join('/'),
        'the file',
        `could not be ${w.body === undefined ? 'deleted' : 'written'} (${e.code ?? e.message})`,
        'fix that, then run mocactl sbx rm again (its record is kept in .sbx/agent-config.json)',
      );
    }
  }
  for (const d of m.dirs) {
    const p = join(root, d);
    try {
      if (readdirSync(p).length === 0) rmdirSync(p);
    } catch {
      // gone already, or not a directory: nothing to take back
    }
  }
  rmSync(join(root, MANIFEST), { force: true });
  return { removed: touched, warnings, recordKept: false };
}

/**
 * Whether the repository at `root` is in Cortex mode: its record says `sbx up --cortex` set it up.
 * A record that cannot be read is not, so its checks stay the strict ones.
 */
export function cortexMode(root: string): boolean {
  return loadManifest(root).m?.cortex === true;
}

/** `takeBackAgentConfig`'s files: what was changed back. */
export function removeAgentConfig(root: string): string[] {
  return takeBackAgentConfig(root).removed;
}

// ---------------------------------------------------------------------------------------------
// The check `sbx doctor` makes

/**
 * Whether the denied state holds (spec §6.1, §6.3): each agent has the sandbox server, and every
 * local built-in in this module's lists is denied. One line per problem; [] when it all holds.
 * `mode` is the sandbox's, as its record says it now: the rules block must then be that mode's
 * (nothing rewrites it on `sbx mode`); without it, any mode's block is up to date.
 */
export function checkAgentConfig(root: string, mode?: SandboxModeName): string[] {
  const problems: string[] = [];
  const cortex = cortexMode(root);
  const load = (rel: string, jsonc: boolean): Json | undefined => {
    try {
      const d = loadDoc(root, rel, jsonc, 'mocactl sbx up re-merges it once fixed');
      return d.exists ? d.data : undefined;
    } catch (err) {
      problems.push((err as Error).message);
      return undefined;
    }
  };
  let ocFile = 'opencode.json';
  try {
    ocFile = opencodeFile(root, 'keep one');
  } catch (err) {
    problems.push((err as Error).message);
  }
  const mcp = load(MCP_JSON, false);
  const settings = load(SETTINGS, false);
  const oc = load(ocFile, true);
  const bob = load(BOB_SETTINGS, false);
  const bobMcp = load(BOB_MCP, false);
  const local = readLocalSettings(root);

  if (!isClaudeServer(at(mcp, ['mcpServers', SERVER]))) {
    problems.push(`Claude Code: ${MCP_JSON} has no ${SERVER} MCP server (mocactl sbx mcp)`);
  }
  const deny = at(settings, ['permissions', 'deny']);
  const denied = Array.isArray(deny) ? deny : [];
  const missing = cortex ? [] : CLAUDE_DENY.filter((t) => !denied.includes(t));
  if (missing.length) {
    problems.push(
      `Claude Code: local built-in tools not denied in ${SETTINGS}: ${missing.join(', ')}`,
    );
  }
  const allow = at(settings, ['permissions', 'allow']);
  const allowed = (Array.isArray(allow) ? allow : []).filter((a) =>
    CLAUDE_DENY.includes(ruleTool(a)),
  );
  if (allowed.length) {
    problems.push(
      `Claude Code: ${SETTINGS} permissions.allow lists local built-in tools: ${allowed.join(', ')}`,
    );
  }
  const enabled = at(settings, ['enabledMcpjsonServers']);
  if (
    !(Array.isArray(enabled) && enabled.includes(SERVER)) &&
    at(settings, ['enableAllProjectMcpServers']) !== true
  ) {
    problems.push(
      `Claude Code: ${SETTINGS} enabledMcpjsonServers does not list ${SERVER}, so Claude Code asks before loading it`,
    );
  }
  for (const [file, data] of [
    [SETTINGS, settings],
    [SETTINGS_LOCAL, local],
  ] as const) {
    if (rejectsServer(data)) {
      // Name the fix: `up` cannot make it, because it never writes settings.local.json and
      // refuses to merge over either rejection (writeAgentConfig's ConfigConflict).
      problems.push(
        `Claude Code: ${file} disabledMcpjsonServers rejects the ${SERVER} MCP server, so the ` +
          `agent has neither the sandbox's tools nor its own; ${
            file === SETTINGS_LOCAL
              ? `delete ${SETTINGS_LOCAL} (mocactl sbx up never writes it) and answer ` +
                `"${CLAUDE_PROMPT_PICK}" the next time Claude Code asks, or start it with ` +
                `mocactl sbx claude, which loads the server without asking`
              : `remove ${SERVER} from disabledMcpjsonServers in ${SETTINGS}`
          }`,
      );
    }
  }
  if (!isOpencodeServer(at(oc, ['mcp', SERVER]))) {
    problems.push(`OpenCode: ${ocFile} has no enabled ${SERVER} MCP server (mocactl sbx mcp)`);
  }
  const on = OPENCODE_OFF.filter((t) => at(oc, ['tools', t]) !== false);
  if (on.length) {
    problems.push(`OpenCode: local built-in tools not disabled in ${ocFile}: ${on.join(', ')}`);
  }
  const back = opencodeReenables(oc);
  if (back.length) {
    problems.push(`OpenCode: ${ocFile} re-enables local built-in tools: ${back.join(', ')}`);
  }
  // Bob only: it has no deny list to check, so there is no local-tools line for it.
  //
  // Either filename satisfies this: which one Bob reads depends on its version (see BOB_SETTINGS),
  // and the one that matters is the one the installed Bob looks at. Requiring both would fail a
  // repository that is working fine.
  if (
    !isBobServer(at(bob, ['mcpServers', SERVER])) &&
    !isBobServer(at(bobMcp, ['mcpServers', SERVER]))
  ) {
    problems.push(
      `IBM Bob: neither ${BOB_SETTINGS} nor ${BOB_MCP} has a ${SERVER} MCP server (mocactl sbx mcp)`,
    );
  }
  const seen = new Set<string>();
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      const t = target(root, f, 'mocactl sbx up re-merges it once fixed');
      if (seen.has(t.abs)) continue;
      seen.add(t.abs);
      const text = t.exists ? readFileSync(t.abs, 'utf8') : '';
      const mk = markers(t.rel, text, 'mocactl sbx up re-merges it once fixed');
      const body = mk ? text.slice(mk[0], mk[1]).replace(/\r\n/g, '\n') : undefined;
      const isBlock = (rules: string) => body === blockFor('\n', rules);
      if (mode !== undefined && !isBlock(rulesFor(mode))) {
        // A block another mode's `up` wrote: the agent is told what that mode keeps.
        const other = MODES.find((m) => isBlock(rulesFor(m)));
        problems.push(
          other !== undefined
            ? `${f}: has the sandbox rules block for ${other} mode, but the sandbox is in ${mode} mode`
            : `${f}: ${body === undefined ? 'has no' : 'has an out-of-date'} sandbox rules block`,
        );
      } else if (mode === undefined && !ALL_RULES.some(isBlock)) {
        // The block for any mode: the sandbox's own is not known here.
        problems.push(
          `${f}: ${body === undefined ? 'has no' : 'has an out-of-date'} sandbox rules block`,
        );
      }
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return problems;
}
