import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { MAX_STDIN_BYTES, q, WORKSPACE, type Exec, type ExecResult } from '@moca/sandbox-client';
import { sanitizeRemote } from '../core/sanitize.js';
import { MARK_BEGIN, MARK_END } from './agent-config.js';
import { BINDING_URL_RE, SANDBOX_ID_RE, sbxDirProblem, folds, segments } from './state.js';
import { PY_TAR_EXTRACT, tarEntries, type TarEntry } from './tar.js';

/**
 * Code in, patch out (SBX0 spec §6.2). The sandbox is the workspace: the working tree goes in as
 * tar chunks, a baseline is committed inside the sandbox, and what the agent changed comes back as
 * a `git diff` against it. Nothing here writes the laptop's tree except `applyPatch`.
 */
export const CHUNK_TARGET = 8 << 20;
export const MAX_FILE = 12 << 20;
/** No Exec's stdin exceeds it: sandbox-client's own ceiling (the gRPC message is 16 MiB). */
export const MAX_STDIN = MAX_STDIN_BYTES;
export const DEFAULT_MAX_PUSH = 256 << 20;
export const BUILD_EXCLUDES = [
  '__pycache__/',
  '*.pyc',
  'node_modules/',
  '.venv/',
  'venv/',
  '.pytest_cache/',
  '.mypy_cache/',
  'dist/',
  'build/',
  'target/',
] as const;
/**
 * What the sandbox never records, beyond BUILD_EXCLUDES: `.sbx/` is the laptop's binding, so an
 * agent's `.sbx/sandbox.json` must never come back in a patch and repoint it.
 */
const SANDBOX_EXCLUDES = [...BUILD_EXCLUDES, '.sbx/', '/lost+found/'];
/** Files kept only so git keeps a directory: they do not make it source. */
const PLACEHOLDERS = new Set(['.gitkeep', '.keep', '.gitignore']);
/** The directory names BUILD_EXCLUDES leaves out, at any depth. */
const BUILD_DIRS = new Set(
  BUILD_EXCLUDES.filter((e) => e.endsWith('/')).map((e) => e.slice(0, -1)),
);

/**
 * A path as a literal gitignore pattern: glob characters and spaces escaped (git strips a trailing
 * unescaped space), and a line break, which a pattern line cannot hold, matched by `?`.
 */
const globLiteral = (p: string) => p.replace(/[\\*?[ !#]/g, '\\$&').replace(/[\r\n]/g, '?');

/**
 * The anchored negations (`!/<dir>/`) for a NESTED directory with a BUILD_EXCLUDES name that holds
 * a pushed path: such a directory is source, not build output (a Java package
 * `src/main/java/acme/build/`), so a new file the agent writes there must show as a change, be
 * pulled, and stop a push from discarding it. They are passed to git as `-x`, so they beat the
 * repository's own .gitignore too (its `build/` matches `acme/build/`).
 *
 * Never re-included, so that what a build or an install writes there stays out of the patch:
 * - a top-level one (`build/`, `dist/`, `target/`): that is where builds write, even when it
 *   holds a tracked file (`build/keep.txt`);
 * - `node_modules/`, at any depth, even with a vendored, tracked package in it;
 * - anything under either (git does not look inside an excluded directory);
 * - one whose only pushed files are placeholders (`.gitkeep`).
 * The tracked files in all of these are still in the baseline (forced in by name), so the
 * agent's edits to them come back; only its NEW files there are treated as output.
 */
export function reincludes(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    if (PLACEHOLDERS.has(posix.basename(p))) continue;
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i - 1]!;
      if (!BUILD_DIRS.has(seg)) continue;
      if (i === 1 || seg === 'node_modules') break; // output, and so is everything under it
      dirs.add(segs.slice(0, i).join('/'));
    }
  }
  return [...dirs].sort().map((d) => `!/${globLiteral(d)}/`);
}
const SECRET_RE = /^(\.env.*|.*\.pem|.*\.key|id_.*)$/;
/** Each push or pull Exec: a fresh VM extracting at most 14 MiB, or one git command. */
export const SYNC_TIMEOUT_S = 300;
/** Marks a push that has emptied the workspace but not yet committed its baseline. */
const INCOMPLETE = '.git/sbx-push-incomplete';
/**
 * The baseline: a ref of its own, not HEAD, so an agent that commits (or resets) in the sandbox
 * cannot hide its work from `pull` or have it discarded by `push`.
 */
export const BASELINE_REF = 'refs/sbx/baseline';
/**
 * The re-include patterns (`PushPlan.reinclude`), NUL-separated: passed as `-x` (the highest
 * precedence, above an in-tree .gitignore) wherever the sandbox lists the workspace's files.
 */
const REINCLUDE = '.git/sbx-reinclude';

export class PushError extends Error {}

/** A guarded push found changes not yet pulled, and changed nothing. */
export class UnpulledError extends PushError {
  constructor() {
    super('the sandbox has changes not yet pulled');
  }
}

/**
 * An 8.3 short name (`CLAUDE~1`, `MCPJSO~1.JSO`) can stand for any long name on NTFS, guarded ones
 * included, and which one depends on the volume: a pull refuses every such component. Its shape
 * is tight (up to six characters, `~N`, an extension of up to three), so a numbered backup
 * `file.~1~` or `notes~2.markdown` is not one; `notes~2.md` is, and is refused.
 */
const isShortName = (seg: string): boolean =>
  // Windows resolves a short name case-insensitively (`claude~1` is `CLAUDE~1`) and drops a
  // trailing dot or space (`CLAUDE~1 ` is `CLAUDE~1`, as `folds` strips): fold both first.
  /^[^.~]{1,6}~\d+(\.[^.]{0,3})?$/.test(
    seg
      .normalize('NFKC')
      .replace(/[. ]+$/, '')
      .toUpperCase(),
  );
/**
 * Whether a path is in the binding's directory as a case-insensitive or normalizing filesystem
 * (macOS, Windows) would resolve it: `.SBX/` and `.ſbx/` are `.sbx/` there.
 */
export function isBindingPath(p: string): boolean {
  return folds(segments(p)[0]!).includes('.sbx');
}

/** Whether any component of a path folds to `.git` (git refuses most of these itself). */
export function isGitPath(p: string): boolean {
  return segments(p).some((seg) => folds(seg).includes('.git'));
}

/**
 * The local agent configuration and the local hooks a pulled patch must never write (final review
 * C1): each makes this machine run a command or start a program the next time an agent, an editor,
 * git or direnv starts here, outside the sandbox. A directory entry matches at any depth (Claude
 * Code reads `.claude/` only at the root, but refusing everywhere is simpler and safe), and a file
 * entry matches by its last component; `.vscode/` only for the two files named. Folded as
 * `isBindingPath` folds, so `.CLAUDE/` and `.ｍｃｐ.json` match too.
 */
const AGENT_DIRS: Record<string, string> = {
  '.claude': 'Claude Code settings, hooks and commands',
  '.opencode': 'OpenCode configuration and plugins',
  '.codex': 'Codex CLI configuration, which can start MCP servers',
  '.agents': "Codex CLI's repo skills, whose scripts it runs on this machine",
  '.pi': 'Pi extensions, skills and prompts, which it loads as code from the project',
  '.bob': "IBM Bob's settings, which can start MCP servers",
  '.husky': 'git hooks',
};
const AGENT_FILES: Record<string, string> = {
  '.mcp.json': 'MCP servers Claude Code starts',
  'opencode.json': 'OpenCode configuration, which can start MCP servers',
  'opencode.jsonc': 'OpenCode configuration, which can start MCP servers',
  '.envrc': 'a direnv script, run on cd',
};
const VSCODE_FILES: Record<string, string> = {
  'tasks.json': 'VS Code tasks, which can run when the folder opens',
  'settings.json': 'VS Code settings, which can name programs to run',
};
/**
 * The prompt files an agent reads: warned about, not refused (they are text, not executables).
 * `AGENTS.override.md` is Codex CLI's: it is read in preference to `AGENTS.md`, so a new one
 * silently replaces the instructions an agent session reads (#592). `.bobrules` is IBM Bob's own
 * steering file, which `sbx up` does not write and so holds no `sbx` block: a change to it is all
 * change, and warned about whole (#657 review).
 */
const PROMPT_FILES = new Set(['claude.md', 'agents.md', 'agents.override.md', '.bobrules']);

const foldedIn = (seg: string, names: Record<string, string>): string | undefined =>
  folds(seg)
    .map((f) => names[f])
    .find((w) => w !== undefined);

/** Why a path is local agent configuration or a local hook; undefined when it is neither. */
function agentConfigWhy(p: string): string | undefined {
  const segs = segments(p);
  for (let i = 0; i < segs.length; i++) {
    if (isShortName(segs[i]!))
      return 'an 8.3 short name, which may stand for any of these on Windows';
    const dir = foldedIn(segs[i]!, AGENT_DIRS);
    if (dir) return dir;
    if (i === segs.length - 1) {
      // .vscode itself (a patch that makes it a symlink to a directory holding tasks.json).
      if (folds(segs[i]!).includes('.vscode')) return 'VS Code configuration, as a link';
      return foldedIn(segs[i]!, AGENT_FILES);
    }
    if (i === segs.length - 2 && folds(segs[i]!).includes('.vscode')) {
      return foldedIn(segs[i + 1]!, VSCODE_FILES);
    }
  }
  return undefined;
}

/** Whether a path is local agent configuration or a local hook, which a pull never writes. */
export function isAgentConfigPath(p: string): boolean {
  return agentConfigWhy(p) !== undefined;
}

const isPromptPath = (p: string) => folds(segments(p).at(-1)!).some((f) => PROMPT_FILES.has(f));

/** A prompt file's text without the block `sbx up` keeps between its markers (when one pair). */
function outsideBlock(text: string | undefined): string {
  if (text === undefined) return '';
  const b = text.indexOf(MARK_BEGIN);
  const e = text.indexOf(MARK_END);
  const one =
    b >= 0 && e > b && text.indexOf(MARK_BEGIN, b + 1) < 0 && text.indexOf(MARK_END, e + 1) < 0;
  return one ? text.slice(0, b) + text.slice(e + MARK_END.length) : text;
}

function readOrGone(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

const run = promisify(execFile);
async function git(
  cwd: string,
  args: string[],
  input?: Buffer,
  env?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const p = run('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 512 << 20,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  if (input) p.child.stdin?.end(input);
  return (await p).stdout;
}

export async function repoRoot(cwd: string): Promise<string> {
  try {
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).toString().trim();
    if (!top) throw new Error('no work tree');
    return top;
  } catch {
    throw new PushError('not inside a git repository: run sbx up, push and pull from your project');
  }
}

/**
 * An origin URL as `host/path`, the same for every way of writing it: https or ssh
 * (`git@host:team/app.git`, `ssh://git@host:22/team/app`), with or without `.git` or a trailing
 * slash, and never with credentials (`https://user:token@host/...`), which must not reach the
 * hash. The host is lowercased; the path is kept as written. A local path is left as it is.
 */
export function normalizeOrigin(url: string): string {
  const u = url.trim();
  const tidy = (host: string, path: string) =>
    `${host.toLowerCase()}/${path
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')}`;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(u);
  if (scheme) return tidy(scheme[1]!, scheme[2] ?? '');
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.*)$/.exec(u); // git@host:team/app.git
  if (scp && !/^[a-z]:[\\/]/i.test(u)) return tidy(scp[1]!, scp[2]!);
  return u.replace(/\/+$/, '');
}

/**
 * sha256(the normalized origin URL and the worktree's real path)[:16]: the `project` label
 * `sbx up` finds sandboxes by. Each worktree (and each clone) is its own project, so two worktrees
 * of one repository never share, and silently re-push, one sandbox (final review I2). The path is
 * the realpath of `git rev-parse --show-toplevel`, so a symlinked or relative path is the same
 * worktree. A binding written when the label hashed the origin alone still works: `up` prefers the
 * bound id over the label.
 */
export async function repoId(root: string): Promise<string> {
  let origin = '';
  try {
    origin = (await git(root, ['remote', 'get-url', 'origin'])).toString().trim();
  } catch {
    origin = '';
  }
  const top = realpathSync(await repoRoot(root));
  return createHash('sha256')
    .update(origin ? `${normalizeOrigin(origin)}\n${top}` : top)
    .digest('hex')
    .slice(0, 16);
}

export interface PushPlan {
  /** gzip tars, each at most MAX_STDIN, extracted in order. */
  chunks: Buffer[];
  /** What the baseline must contain: every pushed path. */
  paths: string[];
  /** The sandbox's `info/exclude` negations for build-named directories that hold pushed paths. */
  reinclude: string[];
  files: number;
  /** Uncompressed bytes of file content. */
  bytes: number;
  excludedSecrets: string[];
  skipped: string[];
}

const mib = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;

/** The NUL-separated names of `git ls-files -z`, refusing any that would not survive as UTF-8. */
function splitNames(raw: Buffer): string[] {
  const out: string[] = [];
  const bad: string[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i < raw.length && raw[i] !== 0) continue;
    if (i > start) {
      const b = raw.subarray(start, i);
      const s = b.toString('utf8');
      if (Buffer.from(s, 'utf8').equals(b)) out.push(s);
      else bad.push(JSON.stringify(s));
    }
    start = i + 1;
  }
  if (bad.length) {
    throw new PushError(
      `file names that are not valid UTF-8 cannot be pushed (rename them): ${bad.join(', ')}`,
    );
  }
  return out;
}

function lstatOrGone(p: string): Stats | undefined {
  try {
    return lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined; // deleted, still in the index
    throw err;
  }
}

/** What a tar member costs: its header, a PAX record if any, and its padded data. */
const memberBytes = (path: string, size: number) =>
  512 + Math.ceil(size / 512) * 512 + (Buffer.byteLength(path) > 100 ? 1024 + path.length : 512);

/**
 * The push (SBX0 §6.2): `git ls-files --cached --others --exclude-standard`, so tracked files (even
 * under an ignored directory) and untracked ones that are not ignored. Refused, before anything is
 * sent: a file over MAX_FILE (by name), a tree over `maxPush` (with its largest directories).
 */
export async function planPush(
  root: string,
  o: { includeSecrets?: boolean; maxPush?: number } = {},
): Promise<PushPlan> {
  const raw = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const names = [...new Set(splitNames(raw).map((n) => n.replace(/\/$/, '')))];
  const excludedSecrets: string[] = [];
  const skipped: string[] = [];
  const tooBig: string[] = [];
  const byTop = new Map<string, number>();
  const kept: { path: string; st: Stats }[] = [];
  let bytes = 0;
  // Whether each parent directory is a symlink, so no path is read through one (review I2): a
  // tracked conf/x.py, with conf/ replaced locally by a link to ../outside, would read outside.
  const linked = new Map<string, string | undefined>();
  const linkAncestor = (p: string): string | undefined => {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/');
      if (!linked.has(d)) {
        const st = lstatOrGone(join(root, d));
        linked.set(d, st?.isSymbolicLink() ? d : undefined);
      }
      if (linked.get(d)) return linked.get(d);
    }
    return undefined;
  };
  for (const p of names) {
    if (isBindingPath(p)) continue; // the binding is the laptop's
    if (!o.includeSecrets && SECRET_RE.test(posix.basename(p))) {
      excludedSecrets.push(p);
      continue;
    }
    const via = linkAncestor(p);
    if (via) {
      skipped.push(`${p} (under the symlink ${via}: not pushed; the symlink itself is)`);
      continue;
    }
    const st = lstatOrGone(join(root, p));
    if (!st) continue;
    if (st.isDirectory()) {
      skipped.push(`${p} (a submodule or nested repository: not pushed)`);
      continue;
    }
    if (!st.isFile() && !st.isSymbolicLink()) {
      skipped.push(`${p} (not a file or symlink: not pushed)`);
      continue;
    }
    if (st.isFile()) {
      if (st.size > MAX_FILE) {
        // Just over the limit, MiB to one decimal reads as the limit itself: give the bytes.
        tooBig.push(`${p} (${mib(st.size)}, ${st.size} bytes)`);
      }
      bytes += st.size;
      const top = p.includes('/') ? p.slice(0, p.indexOf('/')) : '.';
      byTop.set(top, (byTop.get(top) ?? 0) + st.size);
    }
    kept.push({ path: p, st });
  }
  if (tooBig.length) {
    throw new PushError(
      `files over ${MAX_FILE >> 20} MiB (${MAX_FILE} bytes) are not pushed; remove them, or ` +
        `.gitignore them: ${tooBig.join(', ')}`,
    );
  }
  const max = o.maxPush ?? DEFAULT_MAX_PUSH;
  if (bytes > max) {
    const largest = [...byTop]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k === '.' ? '(top-level files)' : `${k}/`} ${mib(v)}`);
    throw new PushError(
      `the tree is ${mib(bytes)}, over the ${mib(max)} limit (--max-push); largest: ${largest.join(', ')}`,
    );
  }
  const chunks: Buffer[] = [];
  let cur: TarEntry[] = [];
  let curBytes = 0;
  const flush = () => {
    if (!cur.length) return;
    const gz = gzipSync(tarEntries(cur));
    if (gz.length > MAX_STDIN) {
      // Only a file that grew past MAX_FILE since it was measured can get here.
      throw new PushError('a file changed size while the push was being packed: run it again');
    }
    chunks.push(gz);
    cur = [];
    curBytes = 0;
  };
  for (const { path, st } of kept) {
    const abs = join(root, path);
    const mtime = Math.floor(st.mtimeMs / 1000);
    const e: TarEntry = st.isSymbolicLink()
      ? { path, type: 'symlink', mode: 0o777, linkname: readlinkSync(abs), mtime }
      : {
          path,
          type: 'file',
          mode: st.mode & 0o111 ? 0o755 : 0o644,
          data: readFileSync(abs),
          mtime,
        };
    const size = memberBytes(path, e.data?.length ?? 0);
    if (curBytes + size > CHUNK_TARGET) flush();
    cur.push(e);
    curBytes += size;
  }
  flush();
  if (!chunks.length) chunks.push(gzipSync(tarEntries([])));
  const paths = kept.map((k) => k.path);
  return {
    chunks,
    paths,
    reinclude: reincludes(paths),
    files: kept.length,
    bytes,
    excludedSecrets,
    skipped,
  };
}

/**
 * git with nothing of the environment's configuration that would change what is recorded: no
 * hooks, no signing, no line-ending conversion, and any owner (the workspace may be another uid's).
 */
const G = `git -c core.hooksPath=/dev/null -c commit.gpgSign=false -c core.autocrlf=false -c advice.addEmptyPathspec=false -c ${q('safe.directory=*')}`;
const ID = '-c user.name=sbx -c user.email=sbx@localhost';
/** git on the scratch index in `$x` (STATE's). */
const SG = `GIT_INDEX_FILE="$x/index" ${G}`;
/**
 * Adds, to the scratch index, the untracked files under the re-included directories that an
 * ignore rule (BUILD_EXCLUDES, or the repository's own .gitignore) would hide: `-x` patterns beat
 * every ignore file. A no-op when nothing is re-included.
 */
const ADD_REINCLUDED =
  `{ [ ! -s ${REINCLUDE} ] || { set --; while IFS= read -r -d '' p; do set -- "$@" -x "$p"; done < ${REINCLUDE}; ` +
  `${SG} ls-files -z --others --exclude-standard "$@" | ${SG} --literal-pathspecs add -f --pathspec-from-file=- --pathspec-file-nul; }; }`;

const EXTRACT =
  // GNU tar's -z runs gzip: without it, Python's tarfile (which has its own).
  'if command -v tar >/dev/null 2>&1 && command -v gzip >/dev/null 2>&1; then tar -xzf - --no-same-owner; ' +
  `else python3 -c ${q(PY_TAR_EXTRACT)}; fi`;

/** Empties the workspace (lost+found, a filesystem's own, stays), read-only directories included. */
const EMPTY =
  '{ find . -mindepth 1 -path ./lost+found -prune -o ! -type l ! -perm -200 -exec chmod u+w {} + 2>/dev/null || true; } && ' +
  'find . -mindepth 1 -maxdepth 1 ! -name lost+found -exec rm -rf -- {} +';

/**
 * The sandbox's state in `$s` (and, for `clean`/`dirty`, the baseline commit in `$b` and the
 * workspace's current tree in `$t`):
 * - `clean`: the workspace is the baseline;
 * - `dirty`: changes not yet pulled: the workspace's tree (the baseline's entries, then `add -A`,
 *   in a scratch index with no stat data, so every file is hashed and no mtime can hide an edit)
 *   is not the baseline's. A superset of a non-empty `git status --porcelain`
 *   (SBX0 §6.2) that also counts work the agent committed;
 * - `empty`: never pushed, nothing there;
 * - `no_baseline`: files, but no baseline (put there by hand, or the agent removed .git): never
 *   discarded unasked;
 * - `incomplete`: a push emptied the workspace and did not finish.
 */
const STATE =
  'set -o pipefail; ' +
  `if [ -e ${INCOMPLETE} ]; then s=incomplete; ` +
  `elif [ ! -d .git ] || ! b=$(${G} rev-parse -q --verify ${q(`${BASELINE_REF}^{commit}`)} 2>/dev/null); then ` +
  'if [ -n "$(find . -mindepth 1 -maxdepth 1 ! -name lost+found ! -name .git | head -n 1)" ]; then s=no_baseline; else s=empty; fi; ' +
  // A scratch index of its own (mktemp), removed on exit: the agent's index is never touched.
  `else x=$(mktemp -d .git/sbx-tmp.XXXXXX) && trap 'rm -rf "$x"' EXIT && ` +
  `${SG} read-tree "$b" && ${SG} add -A && ${ADD_REINCLUDED} && t=$(${SG} write-tree) || exit 1; ` +
  `if [ "$t" = "$(${G} rev-parse "$b^{tree}")" ]; then s=clean; else s=dirty; fi; fi`;

export type SandboxState = 'clean' | 'dirty' | 'empty' | 'no_baseline' | 'incomplete';

interface SyncOpts {
  signal?: AbortSignal;
  /** Each Exec's timeout, if not SYNC_TIMEOUT_S (doctor's state check: a short one). */
  timeoutS?: number;
}

function outcome(r: ExecResult): string {
  if (r.timedOutS !== undefined) return `timed out after ${r.timedOutS}s`;
  if (r.exitCode < 0) return 'was killed (out of memory, or a signal)';
  const err = sanitizeRemote(r.stderr.toString()).trim().split('\n').slice(-5).join('\n');
  return err || `exit ${r.exitCode}`;
}

async function must(
  exec: Exec,
  command: string,
  what: string,
  o: SyncOpts & { stdin?: Buffer } = {},
): Promise<ExecResult> {
  const r = await exec(command, {
    ...(o.stdin ? { stdin: o.stdin } : {}),
    timeoutS: o.timeoutS ?? SYNC_TIMEOUT_S,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (r.exitCode !== 0) throw new PushError(`${what} failed in the sandbox: ${outcome(r)}`);
  return r;
}

/** NUL-separated paths, cut into slices of at most `max` bytes at name boundaries. */
function pathSlices(paths: string[], max: number): Buffer[] {
  const out: Buffer[] = [];
  let cur: Buffer[] = [];
  let n = 0;
  for (const p of paths) {
    const b = Buffer.from(`${p}\0`, 'utf8');
    if (n + b.length > max && cur.length) {
      out.push(Buffer.concat(cur));
      cur = [];
      n = 0;
    }
    cur.push(b);
    n += b.length;
  }
  out.push(Buffer.concat(cur));
  return out;
}

/** `git add -f` of exactly these paths (stdin), literally: a name is never a glob or a magic. */
const ADD_LISTED = `${G} --literal-pathspecs add -f --pathspec-from-file=- --pathspec-file-nul`;

/**
 * Empties the workspace, extracts every chunk, and commits the baseline: `git add -A`, then the
 * pushed list forced in (R6b), so a tracked file under an ignored directory is in the baseline and
 * an agent's edit of it comes back in the patch.
 */
export async function pushTree(
  exec: Exec,
  plan: PushPlan,
  ws = WORKSPACE,
  o: SyncOpts & {
    onChunk?: (i: number, n: number) => void;
    /**
     * Refuse (UnpulledError, nothing changed) when the sandbox holds changes not yet pulled. The
     * check runs in the same Exec that empties the workspace, so no change can slip in between.
     */
    guard?: boolean;
  } = {},
): Promise<void> {
  const cd = `cd ${q(ws)}`;
  const n = plan.chunks.length;
  const guard = o.guard
    ? `${STATE}; case "$s" in dirty|no_baseline) echo sbx-state:unpulled >&2; exit ${NO_BASELINE};; esac; `
    : '';
  const first =
    `${guard}${EMPTY} && ${G} init -q && mkdir -p .git/info && : > ${INCOMPLETE} && ` +
    `printf '%s\\n' ${[...SANDBOX_EXCLUDES, ...plan.reinclude].map(q).join(' ')} > .git/info/exclude && ` +
    (plan.reinclude.length
      ? `printf '%s\\0' ${plan.reinclude.map(q).join(' ')} > ${REINCLUDE} && `
      : `: > ${REINCLUDE} && `);
  const later = `{ [ -e ${INCOMPLETE} ] || { echo 'the push was interrupted (another push to this sandbox?)' >&2; exit 1; }; } && `;
  for (const [i, c] of plan.chunks.entries()) {
    o.onChunk?.(i + 1, n);
    const r = await exec(`${cd} && ${i === 0 ? first : later}${EXTRACT}`, {
      stdin: c,
      timeoutS: SYNC_TIMEOUT_S,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (i === 0 && guard && r.exitCode === NO_BASELINE && r.stderr.includes('sbx-state:unpulled')) {
      throw new UnpulledError();
    }
    if (r.exitCode !== 0) {
      throw new PushError(`the push (part ${i + 1} of ${n}) failed in the sandbox: ${outcome(r)}`);
    }
  }
  const lists = pathSlices(plan.paths, MAX_STDIN);
  for (const l of lists.slice(0, -1)) {
    await must(exec, `${cd} && ${ADD_LISTED}`, 'recording the baseline', { ...o, stdin: l });
  }
  await must(
    exec,
    `${cd} && ${G} add -A && ${ADD_LISTED} && ` +
      `${G} ${ID} commit -q --no-verify --allow-empty -m sbx-baseline && ` +
      `${G} update-ref ${BASELINE_REF} HEAD && rm -f ${INCOMPLETE}`,
    'the baseline commit',
    { ...o, stdin: lists.at(-1)! },
  );
}

export async function sandboxState(
  exec: Exec,
  ws = WORKSPACE,
  o: SyncOpts = {},
): Promise<SandboxState> {
  const r = await must(exec, `cd ${q(ws)} && ${STATE} && echo "$s"`, 'checking for changes', o);
  const s = r.stdout.toString().trim();
  if (!['clean', 'dirty', 'empty', 'no_baseline', 'incomplete'].includes(s)) {
    throw new PushError(`checking for changes: unexpected answer from the sandbox`);
  }
  return s as SandboxState;
}

/**
 * After a template's seed left a clean git tree in the workspace: its HEAD becomes the sbx baseline,
 * so `pull` returns only what came after the seed, and `rm` sees no unpulled changes (a seed's tree
 * is the template's, not the caller's work).
 */
export async function baselineAtHead(exec: Exec, ws = WORKSPACE, o: SyncOpts = {}): Promise<void> {
  await must(
    exec,
    `cd ${q(ws)} && ${G} rev-parse -q --verify HEAD >/dev/null && ${G} update-ref ${BASELINE_REF} HEAD`,
    'recording the seed as the baseline',
    o,
  );
}

/**
 * Whether the sandbox holds work a push would discard: changes since the baseline, or files with
 * no baseline at all. An unfinished push holds none (it emptied the workspace first).
 */
export async function hasUnpulled(exec: Exec, ws = WORKSPACE, o: SyncOpts = {}): Promise<boolean> {
  const s = await sandboxState(exec, ws, o);
  return s === 'dirty' || s === 'no_baseline';
}

const TREE_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const NO_BASELINE = 3;
/** Stops a command unless the state is clean or dirty, naming the state on stderr. */
const NEED_BASELINE = `case "$s" in clean|dirty) ;; *) echo "sbx-state:$s" >&2; exit ${NO_BASELINE};; esac`;

function noBaseline(r: ExecResult): PushError | undefined {
  const s = /sbx-state:(\w+)/.exec(r.stderr.toString())?.[1];
  if (r.exitCode !== NO_BASELINE || !s) return undefined;
  return new PushError(
    s === 'incomplete'
      ? 'the last push to the sandbox did not finish: run mocactl sbx push'
      : 'the sandbox has no baseline to diff against (it was never pushed, or its .git was removed): ' +
          'run mocactl sbx push --force to replace what is there, or fetch files with mocactl sbx run',
  );
}

/**
 * The agent's changes: the binary diff from the baseline to the workspace as it is now, and that
 * tree's id (for `advanceBaseline`). Refused when stdout was cut at the worker's 8 MiB cap: a cut
 * patch is never returned (spec §10.3).
 */
export async function capture(
  exec: Exec,
  ws = WORKSPACE,
  o: SyncOpts = {},
): Promise<{ patch: Buffer; tree: string }> {
  const command =
    `cd ${q(ws)} && ${STATE} && ${NEED_BASELINE} && printf '%s\\n' "$t" && ` +
    `${G} diff --binary --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ "$b" "$t"`;
  const r = await exec(command, {
    timeoutS: SYNC_TIMEOUT_S,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const nb = noBaseline(r);
  if (nb) throw nb;
  if (r.exitCode !== 0) {
    throw new PushError(`capturing the patch failed in the sandbox: ${outcome(r)}`);
  }
  if (r.truncated) {
    throw new PushError(
      "the sandbox's changes are over 8 MiB as a patch, more than one Exec returns, so nothing was " +
        'pulled; pull them in parts: mocactl sbx run -- git diff --binary sbx/baseline -- PATH ...',
    );
  }
  const nl = r.stdout.indexOf(0x0a);
  const tree = nl > 0 ? r.stdout.subarray(0, nl).toString() : '';
  if (!TREE_RE.test(tree)) {
    throw new PushError('capturing the patch: unexpected answer from the sandbox');
  }
  return { patch: r.stdout.subarray(nl + 1), tree };
}

export async function capturePatch(exec: Exec, ws = WORKSPACE, o: SyncOpts = {}): Promise<Buffer> {
  return (await capture(exec, ws, o)).patch;
}

/**
 * Makes what was pulled the sandbox's baseline, so the next pull holds only newer changes (spec
 * §6.2). With `tree` (from `capture`), exactly that tree, with no second hash of the workspace,
 * so a change the agent made after the capture is still pulled next time; without, the workspace
 * as it is now (one full hash). HEAD follows when the agent has not moved it, so its own
 * `git diff` shows only unpulled work. The agent's index is kept, except the entries of the pulled
 * paths, which are set to the new HEAD's (their content was pulled); without that, its
 * `git status` would show every pulled change as staged in reverse. The agent's own commits and
 * the workspace's files are never touched.
 */
export async function advanceBaseline(
  exec: Exec,
  ws = WORKSPACE,
  tree?: string,
  o: SyncOpts = {},
): Promise<void> {
  if (tree !== undefined && !TREE_RE.test(tree)) throw new PushError(`not a tree id: ${tree}`);
  const head =
    tree === undefined
      ? `${STATE} && ${NEED_BASELINE} && `
      : `{ [ ! -e ${INCOMPLETE} ] || { echo sbx-state:incomplete >&2; exit ${NO_BASELINE}; }; } && ` +
        `{ b=$(${G} rev-parse -q --verify ${q(`${BASELINE_REF}^{commit}`)}) || ` +
        `{ echo sbx-state:no_baseline >&2; exit ${NO_BASELINE}; }; } && t=${tree} && `;
  const command =
    `cd ${q(ws)} && ${head}` +
    `c=$(${G} ${ID} commit-tree "$t" -p "$b" -m sbx-pulled) && ` +
    `${G} update-ref ${BASELINE_REF} "$c" "$b" && ` +
    `if [ "$(${G} rev-parse -q --verify HEAD)" = "$b" ]; then ` +
    `${G} update-ref HEAD "$c" "$b" && y=$(mktemp -d .git/sbx-tmp.XXXXXX) && trap 'rm -rf "\${x:-}" "$y"' EXIT && ` +
    `${G} diff --name-only -z --no-renames "$b" "$c" > "$y/paths" && ` +
    `{ [ ! -s "$y/paths" ] || ${G} --literal-pathspecs reset -q "$c" --pathspec-from-file="$y/paths" --pathspec-file-nul; } && ` +
    `rm -rf "$y"; fi`;
  const r = await exec(command, {
    timeoutS: SYNC_TIMEOUT_S,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const nb = noBaseline(r);
  if (nb) throw nb;
  if (r.exitCode !== 0)
    throw new PushError(`advancing the baseline failed in the sandbox: ${outcome(r)}`);
}

/**
 * Every path a patch reads or writes: the new side from `git apply --numstat -z`, and the old side
 * from git's own reverse read of it (`-R --numstat`). The forward read alone names only the new
 * side, so a deletion (`+++ /dev/null`, listed as `dev/null`) or a `---` that names another file
 * than `+++` would carry a guarded path past every check unseen (#554 review).
 */
async function patchPaths(root: string, file: string): Promise<string[]> {
  const numstat = async (args: string[]): Promise<string[]> => {
    let raw: Buffer;
    try {
      raw = await git(root, ['apply', ...args, '--numstat', '-z', file]);
    } catch (err) {
      throw new PushError(
        `the patch is not one git can read; nothing was changed (${gitText(err)})`,
      );
    }
    const t = raw.toString('utf8').split('\0');
    const out: string[] = [];
    for (let i = 0; i < t.length; i++) {
      const m = /^(?:\d+|-)\t(?:\d+|-)\t(.*)$/s.exec(t[i]!);
      if (!m) continue;
      if (m[1]) out.push(m[1]);
      else out.push(t[++i]!, t[++i]!); // a rename: the old path, then the new
    }
    return out;
  };
  const out = [...(await numstat([])), ...(await numstat(['-R']))];
  // A backstop, should git's reading ever differ from ours: every old-side path the headers name.
  out.push(...patchSourcePaths(readFileSync(file, 'utf8')));
  // `dev/null` is how numstat names the missing side of a creation or a deletion, not a path.
  return [...new Set(out.filter((p) => p && p !== 'dev/null'))];
}

/** A path as git writes it in a patch header: bare, or C-quoted ("…" with \-escapes and octal). */
function headerPath(s: string): string {
  if (!s.startsWith('"')) return s;
  const bytes: number[] = [];
  const body = s.slice(1, s.endsWith('"') ? -1 : undefined);
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = body[++i] ?? '';
    const oct = /^[0-7]{3}/.exec(body.slice(i));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 2;
    } else {
      const esc: Record<string, number> = {
        n: 10,
        t: 9,
        r: 13,
        '"': 34,
        '\\': 92,
        a: 7,
        b: 8,
        f: 12,
        v: 11,
      };
      bytes.push(esc[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The old-side paths a patch's headers name: rename and copy sources, every `--- a/<path>`, and
 * the `a/` side of `diff --git a/<old> b/<new>` when it can be split unambiguously.
 */
export function patchSourcePaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    const from = /^(?:rename|copy) from (.+)$/.exec(line);
    if (from) {
      out.push(headerPath(from[1]!));
      continue;
    }
    const minus = /^--- (.+?)\t?$/.exec(line);
    if (minus && minus[1] !== '/dev/null') {
      const p = headerPath(minus[1]!);
      out.push(p.startsWith('a/') ? p.slice(2) : p);
      continue;
    }
    const dg = /^diff --git (.+)$/.exec(line);
    if (dg) {
      const rest = dg[1]!;
      const quoted = /^("(?:[^"\\]|\\.)*")/.exec(rest);
      if (quoted) out.push(headerPath(quoted[1]!).replace(/^a\//, ''));
      else if (rest.startsWith('a/')) {
        // Unquoted: `a/<old> b/<new>`. With a space in a path the split is ambiguous, so every
        // candidate old side is listed: erring wide only refuses more.
        for (let i = rest.indexOf(' b/'); i > 0; i = rest.indexOf(' b/', i + 1)) {
          out.push(rest.slice(2, i));
        }
      }
    }
  }
  return out;
}

/**
 * Of `touched`, every path with a local change not committed: modified, staged, unmerged,
 * untracked, or an ignored file that exists (a patch creating it must not overwrite it).
 */
async function uncommitted(root: string, touched: string[]): Promise<string[]> {
  const t = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    .toString('utf8')
    .split('\0');
  const out = new Set<string>();
  for (let i = 0; i < t.length; i++) {
    const e = t[i]!;
    if (e.length < 4) continue;
    out.add(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') out.add(t[++i]!); // the rename's source
  }
  const indexed = new Set(
    (await git(root, ['ls-files', '-z'])).toString('utf8').split('\0').filter(Boolean),
  );
  // An ignored file is in neither list; one the patch touches is local data all the same.
  return touched.filter(
    (p) => out.has(p) || (!indexed.has(p) && lstatOrGone(join(root, p)) !== undefined),
  );
}

const gitText = (err: unknown) =>
  sanitizeRemote(String((err as { stderr?: Buffer }).stderr ?? err))
    .trim()
    .split('\n')
    .filter((l) => !/^(Falling back|Applied patch|Recorded preimage)/.test(l))
    .slice(0, 8)
    .join('; ');

/** The paths git names in a failed apply's `error: <path>: ...` lines. */
function failedPaths(err: unknown): string[] {
  const text = String((err as { stderr?: Buffer }).stderr ?? '');
  const out = new Set<string>();
  for (const m of text.matchAll(/^error: (?:patch failed: )?(.+?)(?::\d+)?(?:: .*)?$/gm)) {
    out.add(sanitizeRemote(m[1]!));
  }
  return [...out];
}

const list = (ps: string[]) =>
  ps.length > 10 ? `${ps.slice(0, 10).join(', ')} and ${ps.length - 10} more` : ps.join(', ');

/**
 * `git apply --3way --cached` into a throwaway index read from HEAD: the paths it leaves unmerged
 * (empty when the merge is clean). The user's index and working tree are not touched.
 */
async function dryRun3way(root: string, dir: string, patch: string): Promise<string[]> {
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  await git(root, ['read-tree', 'HEAD'], undefined, env);
  try {
    await git(root, ['apply', '--3way', '--cached', '--whitespace=nowarn', patch], undefined, env);
    return [];
  } catch (err) {
    const unmerged = (await git(root, ['ls-files', '-u', '-z'], undefined, env))
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((l) => l.slice(l.indexOf('\t') + 1));
    if (unmerged.length) return [...new Set(unmerged)];
    throw new PushError(
      `the patch does not apply here; nothing was changed (git said: ${gitText(err)})`,
    );
  }
}

/**
 * Applies a pulled patch in the local repository (R6c). First, a patch that writes `.git`, the
 * `.sbx/` binding, or local agent configuration or hooks (`isAgentConfigPath`) is refused whole,
 * before git is asked to apply anything. Then:
 * 1. a plain `git apply`, which changes only the working tree and is all or nothing;
 * 2. if that fails because a file it touches has uncommitted local changes, it is refused with
 *    those files named, and nothing is changed;
 * 3. otherwise (the files differ only by local commits), a 3-way merge, dry-run first in a
 *    throwaway index: a conflict is refused, naming the files, with nothing applied, staged or
 *    marked. Only a clean merge is applied for real, and the touched paths' index entries go back
 *    to what they were (their HEAD), so the index is as before.
 * Returns the paths the patch touched. A `CLAUDE.md` or `AGENTS.md` it changed outside the sbx
 * block is applied, with `o.warn` told.
 */
export async function applyPatch(
  root: string,
  patch: Buffer,
  o: {
    /** A warning for the user (stderr): a prompt file changed outside the sbx block. */
    warn?: (s: string) => void;
  } = {},
): Promise<string[]> {
  if (patch.length === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), 'sbx-pull-'));
  const f = join(dir, 'sbx.patch');
  writeFileSync(f, patch, { mode: 0o600 });
  try {
    const touched = await patchPaths(root, f);
    // The binding is the laptop's: a patch that would write it (an agent that un-excluded .sbx/
    // in the sandbox) could repoint every later command, so it is refused outright.
    const gitPaths = touched.filter(isGitPath);
    if (gitPaths.length) {
      throw new PushError(
        `the patch writes ${list(gitPaths)}, inside a repository's .git, which a pull never ` +
          'changes; nothing was changed. Look at it with mocactl sbx pull -o FILE',
      );
    }
    const binding = touched.filter(isBindingPath);
    if (binding.length) {
      throw new PushError(
        `the patch writes ${list(binding)}, this repository's sandbox binding, which a pull never ` +
          'changes; nothing was changed. Look at it with mocactl sbx pull -o FILE',
      );
    }
    // The sandbox cannot be trusted with what runs on this machine: a patch that rewrites the
    // agent's settings (a hook, an emptied deny list) or adds an MCP server would run here at the
    // next agent start, and these files are often uncommitted, so `git diff` would not show it.
    const config = touched.filter(isAgentConfigPath);
    if (config.length) {
      throw new PushError(
        `the patch writes ${list(config.map((p) => `${p} (${agentConfigWhy(p)})`))}: local ` +
          'agent configuration or hooks, which could run commands on this machine, outside the ' +
          'sandbox, so a pull never writes them; nothing was changed. Save the patch with ' +
          'mocactl sbx pull -o FILE, review it, and apply what you want by hand ' +
          '(git apply --exclude=PATH FILE leaves a file out)',
      );
    }
    const prompts = touched.filter(isPromptPath);
    const before = new Map(prompts.map((p) => [p, outsideBlock(readOrGone(join(root, p)))]));
    const applied = () => {
      const changed = prompts.filter(
        (p) => outsideBlock(readOrGone(join(root, p))) !== before.get(p),
      );
      if (changed.length && o.warn) {
        o.warn(
          `the patch changes ${list(changed)} outside the sbx block: agent instructions, which ` +
            'your next agent session reads, so review them (git diff, or git status for a new file)',
        );
      }
      return touched;
    };
    let plainErr: unknown;
    try {
      await git(root, ['apply', '--whitespace=nowarn', f]);
      return applied();
    } catch (err) {
      plainErr = err;
    }
    const local = await uncommitted(root, touched);
    if (local.length) {
      const failing = failedPaths(plainErr).filter((p) => !local.includes(p));
      throw new PushError(
        `the patch does not apply here, and it touches files with local changes not yet ` +
          `committed (${list(local)}), so no 3-way merge was tried; nothing was changed. ` +
          (failing.length ? `It also does not apply to ${list(failing)} as committed. ` : '') +
          'Commit or stash the local changes, then run mocactl sbx pull --apply again ' +
          `(git said: ${gitText(plainErr)})`,
      );
    }
    // A dry run first, in a throwaway index from HEAD (whose touched entries the user's index
    // matches, by step 2): a conflict is found there, with nothing applied, staged or marked.
    const conflicts = await dryRun3way(root, dir, f);
    if (conflicts.length) {
      throw new PushError(
        `the patch conflicts with local commits in ${list(conflicts)}; nothing was applied. ` +
          'Save it with mocactl sbx pull -o FILE and merge it by hand (git apply --3way FILE), ' +
          'then make the sandbox match with mocactl sbx push --force',
      );
    }
    try {
      await git(root, ['apply', '--3way', '--whitespace=nowarn', f]);
    } catch (err) {
      // The dry run was clean, so only a change made meanwhile gets here.
      throw new PushError(
        `the patch did not apply (git said: ${gitText(err)}); check git status, as files it ` +
          `touches may have changed: ${list(touched)}`,
      );
    }
    // A clean merge staged its paths; they were at HEAD before (step 2), so put the index back.
    if (touched.length) {
      await git(
        root,
        ['--literal-pathspecs', 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'],
        Buffer.from(touched.join('\0') + '\0', 'utf8'),
      );
    }
    return applied();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The control-plane URL as later commands will read it back (`readBinding`: http(s), printable
 * ASCII), unchanged, since it must equal the login's URL. An internationalized host is refused
 * with its ASCII form to use instead: rewriting it here would no longer match the login.
 */
export function bindingUrl(url: string): string {
  let u: URL | undefined;
  try {
    u = new URL(url);
  } catch {
    u = undefined;
  }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
    throw new PushError(`the control-plane URL is not an http(s) URL: ${sanitizeRemote(url)}`);
  }
  if (BINDING_URL_RE.test(url)) return url;
  const ascii = u.href.replace(/\/+$/, '');
  if (BINDING_URL_RE.test(ascii)) {
    throw new PushError(
      `the control-plane URL must be ASCII to be recorded in .sbx/sandbox.json; use ${ascii} ` +
        `(log in with mocactl sbx login --control-plane-url ${q(ascii)})`,
    );
  }
  throw new PushError(`the control-plane URL cannot be recorded: ${sanitizeRemote(url)}`);
}

/** `info/exclude` of the repository at `root`: the common one, for a linked worktree too. */
function excludeFile(root: string): string {
  const p = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return resolve(root, p);
}

/**
 * Binds the repository to its sandbox: `.sbx/sandbox.json`, with `.sbx/` added to the
 * repository's `info/exclude`, never to `.gitignore` (spec §6.1). Refuses a binding later commands
 * would silently ignore (a bad id, a URL `readBinding` would drop).
 */
export function writeBinding(
  root: string,
  b: { id: string; controlPlaneUrl: string; template: string },
): void {
  if (!SANDBOX_ID_RE.test(b.id)) throw new PushError(`not a sandbox id: ${sanitizeRemote(b.id)}`);
  const sbxBad = sbxDirProblem(root);
  if (sbxBad) {
    throw new PushError(
      `.sbx ${sbxBad}, so the binding is not written there: remove it from the repository (git rm -r --cached .sbx) or replace the link`,
    );
  }
  const controlPlaneUrl = bindingUrl(b.controlPlaneUrl);
  const exclude = excludeFile(root);
  mkdirSync(dirname(exclude), { recursive: true });
  // Read, not tested then read: a missing file is the only case that means "empty".
  let cur = '';
  try {
    cur = readFileSync(exclude, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!cur.split('\n').some((l) => l.trim() === '.sbx/' || l.trim() === '/.sbx/')) {
    appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.sbx/\n`);
  }
  mkdirSync(join(root, '.sbx'), { recursive: true });
  const f = join(root, '.sbx', 'sandbox.json');
  const tmp = `${f}.${process.pid}.tmp`;
  rmSync(tmp, { force: true }); // created fresh, so its mode is the one given
  // 0600: the binding names the user's sandbox and control plane, for no one else on the machine.
  writeFileSync(
    tmp,
    JSON.stringify({ id: b.id, controlPlaneUrl, template: b.template }, null, 2) + '\n',
    { mode: 0o600 },
  );
  renameSync(tmp, f);
}
