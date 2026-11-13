// The build's version: a release tag, `edge-<sha>`, or `dev`. build.mjs bakes it in with esbuild's
// `define` (docs/specs/2026-10-08-mocactl-installer-design.md §4). Running from a checkout under tsx,
// nothing defines the constant, so `typeof` (safe on an undeclared global) falls back to `dev`.
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const MOCACTL_VERSION: string | undefined;

export const VERSION: string = typeof MOCACTL_VERSION === 'string' ? MOCACTL_VERSION : 'dev';

type Git = (args: string[]) => string;

const runGit: Git = (args) =>
  execFileSync('git', ['-C', dirname(fileURLToPath(import.meta.url)), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000,
  });

/**
 * What `mocactl --version` prints. A built release prints its baked-in VERSION. From a source
 * checkout, `dev` alone can't tell two checkouts apart, so it names the commit the sources are at:
 * `dev-<sha>`, plus `-dirty` when tracked files differ from it. Plain `dev` when git can't say
 * (no git, not a checkout). Only `--version` asks git: the banner and the MCP server keep VERSION,
 * so nothing else spawns a process at startup.
 */
export function versionLine(version: string = VERSION, git: Git = runGit): string {
  if (version !== 'dev') return version;
  try {
    const sha = git(['rev-parse', '--short=8', 'HEAD']).trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return version;
    const dirty = git(['status', '--porcelain', '--untracked-files=no']).trim() !== '';
    return `dev-${sha}${dirty ? '-dirty' : ''}`;
  } catch {
    return version;
  }
}
