import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildBundleInput, PromoteMode } from '@moca/config-bundle';

/** Where the generated lockfile is written, for committing alongside the code it configures. */
export const LOCKFILE_OUT = '.claude/promoted.lock.json';

export interface PromoteArgs {
  entry: string;
  mode: PromoteMode;
  sandboxImage: string;
  deny: string[];
  /** Prompt names to keep out of the bundle; see BuildBundleInput.excludePrompts. */
  excludePrompts: string[];
  dryRun: boolean;
  project?: string;
  /** User scope to read skills, memory and prompts from; overrides `$HOME`. See `--home` below. */
  home?: string;
  /** Redis to upload the bundle to; overrides `$REDIS_URL`. See `--redis-url` below. */
  redisUrl?: string;
}

export function parsePromoteArgs(argv: string[]): PromoteArgs {
  const args: PromoteArgs = {
    entry: '',
    mode: 'unattended',
    // Matches deploy/knative/setup-k8s.sh:30 so the checked-in inventory (Task 14) resolves.
    sandboxImage: 'ghcr.io/rossoctl/moca-sandbox:latest',
    deny: [],
    excludePrompts: [],
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (flag === '--entry') ((args.entry = value ?? ''), i++);
    else if (flag === '--mode') {
      if (value !== 'unattended' && value !== 'attended') {
        throw new Error(`--mode must be 'unattended' or 'attended', got '${value ?? ''}'`);
      }
      args.mode = value;
      i++;
    } else if (flag === '--sandbox-image') ((args.sandboxImage = value ?? ''), i++);
    else if (flag === '--deny') (args.deny.push(value ?? ''), i++);
    else if (flag === '--exclude-prompt') {
      // Unlike --deny, reject an empty value: a silently-empty exclusion matches no prompt and
      // ships the one the caller meant to omit.
      if (!value) throw new Error('--exclude-prompt requires a prompt name');
      args.excludePrompts.push(value);
      i++;
    } else if (flag === '--project') {
      if (!value) throw new Error('--project requires a directory');
      args.project = value;
      i++;
    } else if (flag === '--home') {
      // Empty would resolve() to '/' and sweep the whole filesystem's skills into a shared bundle.
      if (!value) throw new Error('--home requires a directory');
      args.home = value;
      i++;
    } else if (flag === '--redis-url') {
      // Empty must not fall through to $REDIS_URL: the caller who passed the flag is the caller
      // being explicit about which Redis, and there are two that answer on this machine.
      if (!value) throw new Error('--redis-url requires a url');
      args.redisUrl = value;
      i++;
    } else if (flag === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!args.entry) {
    throw new Error(
      'usage: promote --entry <prompt-name> [--project <dir>] [--home <dir>] ' +
        '[--redis-url <url>] [--mode attended] [--exclude-prompt <name>]',
    );
  }
  return args;
}

/**
 * The project directory to promote from: `--project` resolved to an absolute path, or `cwd`
 * (the process's own working directory) when `--project` was not given.
 *
 * This is the fix for the only shipped invocation (`cd harness && pnpm promote`) silently
 * promoting the harness checkout's own configuration: `pnpm run` sets `cwd` to the package
 * directory, not the directory the caller actually meant, so an explicit `--project` is the only
 * reliable way to name "the project" from inside a workspace script.
 */
export function resolveProjectDir(args: Pick<PromoteArgs, 'project'>, cwd: string): string {
  return args.project !== undefined ? resolve(args.project) : cwd;
}

/**
 * The user scope to read skills, memory and prompts from: `--home` resolved to an absolute path,
 * or `home` (the process's own `$HOME`) when the flag was not given.
 *
 * The flag exists because the env-var form of the same thing -- `HOME=<dir> pnpm ... promote` --
 * cannot be granted inside Claude Code. Claude Code parses each Bash command and will only match a
 * grant like `Bash(pnpm:*)` against a command it can analyse statically; an inline `VAR=value`
 * prefix does not match, and a `$VAR` argument is classified unanalyzable outright. So the
 * documented `/promote` invocation has to be one plain `pnpm ...` line with literal paths, and
 * every input the env used to carry needs a flag. Outside Claude Code (the shell demo)
 * `HOME=<dir>` still works: the flag only overrides it.
 */
export function resolveHomeDir(args: Pick<PromoteArgs, 'home'>, home: string): string {
  return args.home !== undefined ? resolve(args.home) : home;
}

/**
 * Mirror Claude Code's own project slug: path separators replaced with '-'.
 *
 * This scheme is lossy -- `/a/my-project` and `/a/my/project` both slug to `-a-my-project` -- and
 * that is INHERITED ON PURPOSE. Verified against a real install: the directory Claude Code created
 * for this repo is `-Users-paolo-Projects-aiplatform-serverless-harness`, hyphen in the final
 * segment and all. Our job is to FIND the directory Claude Code already made, so a "safer",
 * collision-free scheme would simply miss it and silently promote no memory at all. Do not
 * "improve" this.
 */
export function projectMemoryDir(cwd: string, home: string): string {
  return join(home, '.claude', 'projects', cwd.split(/[/\\]/).join('-'), 'memory');
}

/** Relative location of the checked-in sandbox inventories, from a repo or package root. */
export const INVENTORY_SUBDIR = join('deploy', 'knative', 'sandbox-inventory');

/** The inventory filename for an image ref: `:` and `/` become `_`. Mirrors readInventory's key. */
export function inventoryFileName(image: string): string {
  return `${image.replace(/[:/]/g, '_')}.json`;
}

/**
 * Candidate inventory paths for an image, in precedence order.
 *
 * The inventory is a HARNESS-SHIPPED asset, so it must be found relative to where the harness is
 * installed -- NOT relative to the invocation directory. `sh promote` is run from the user's own
 * project (that is the whole point of the feature), and a user's project will never contain
 * `deploy/knative/sandbox-inventory/`. Resolving against `cwd` alone made the binary check
 * silently degrade to `inventory_unavailable` for every real caller, which is the "lying
 * preflight" this inventory exists to prevent -- measured: from the repo root the check produced
 * 29 findings, from one directory deeper it produced none.
 *
 * `cwd` is kept as a LOWER-precedence fallback so a caller can still override with a local file.
 */
export function inventoryCandidates(image: string, cwd: string, moduleDir: string): string[] {
  const file = inventoryFileName(image);
  const out: string[] = [];
  // Walk up from the module: src/ -> package -> repo root (and any bundling layout in between).
  let dir = moduleDir;
  for (;;) {
    out.push(join(dir, INVENTORY_SUBDIR, file));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  out.push(join(cwd, INVENTORY_SUBDIR, file));
  return out;
}

/**
 * The first existing inventory path for an image, or undefined.
 *
 * Exposed separately from `readInventory` so the CLI can SAY which file it used. The precedence
 * is deliberately silent-proof: a shipped inventory outranks a cwd-local one, so without a
 * diagnostic a caller who deliberately dropped an override next to their project would be
 * shadowed by the shipped copy with no way to tell.
 */
export function resolveInventoryPath(
  image: string,
  cwd: string,
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  return inventoryCandidates(image, cwd, moduleDir).find((path) => existsSync(path));
}

/** Checked-in inventory for a sandbox image tag; absent => preflight warns instead of verifying. */
export function readInventory(
  image: string,
  cwd: string,
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): string[] | undefined {
  const path = resolveInventoryPath(image, cwd, moduleDir);
  if (path === undefined) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')).binaries as string[];
}

/**
 * The nearest ancestor holding a `.git` entry, or `cwd` when there is none.
 *
 * This bounds the context-file walk. Without it the walk reaches the filesystem root and sweeps
 * every ancestor `CLAUDE.md` -- including a personal `~/CLAUDE.md` -- into a bundle that lands in a
 * shared Redis store.
 *
 * `existsSync` is deliberate rather than a directory check: in a linked worktree `.git` is a *file*
 * containing a `gitdir:` pointer, not a directory, and this repo uses worktrees heavily. A
 * directory-only test would walk straight past the boundary in exactly the checkout where it is
 * needed most.
 */
export function projectRoot(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root without finding .git, return the original cwd.
      return cwd;
    }
    dir = parent;
  }
}

/** The CLAUDE.md / AGENTS.md chain from the project root down to `cwd`, outermost first. */
export function collectContextFiles(cwd: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const root = projectRoot(cwd);
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === root) break;
  }
  for (const dir of dirs) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = join(dir, name);
      if (existsSync(path)) {
        out.push({ path, content: readFileSync(path, 'utf8') });
        break;
      }
    }
  }
  return out;
}

/** Assemble buildBundle's input from Claude Code's own on-disk layout. */
export function promoteInputs(opts: {
  cwd: string;
  home: string;
  args: PromoteArgs;
  inventory?: string[];
  versions: { pi: string; harness: string };
}): BuildBundleInput {
  const userDir = join(opts.home, '.claude');
  return {
    roots: {
      projectDir: join(opts.cwd, '.claude'),
      userDir,
      pluginDirs: [join(userDir, 'plugins')],
    },
    memoryDir: projectMemoryDir(opts.cwd, opts.home),
    promptsDir: join(userDir, 'commands'),
    contextFiles: collectContextFiles(opts.cwd),
    entry: opts.args.entry,
    mode: opts.args.mode,
    userDenyList: opts.args.deny,
    excludePrompts: opts.args.excludePrompts,
    sandboxImage: opts.args.sandboxImage,
    ...(opts.inventory ? { inventory: opts.inventory } : {}),
    versions: opts.versions,
  };
}
