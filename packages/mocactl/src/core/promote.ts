import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildBundle,
  hasErrors,
  MAX_BUNDLE_BYTES,
  renderPreflight,
  SecretScanError,
} from '@moca/config-bundle';
import type { ControlPlaneApi } from '../api/types.js';

export class PromoteError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3,
  ) {
    super(message);
    this.name = 'PromoteError';
  }
}

/** What the build produced, available before anything is uploaded. */
export interface PromoteSummary {
  digest: string;
  configRoot: string;
  skills: string[];
  dropped: Array<{ name: string; reason: string }>;
  prompts: string[];
  report: string;
  warnings: number;
}

export interface PromoteResult extends PromoteSummary {
  uploaded: boolean;
  dryRun?: true;
}

export interface PromoteOptions {
  /** Called once preflight has passed, before the upload, so the report is seen first. */
  onBuilt?: (summary: PromoteSummary) => void;
  /** Build and report only; nothing is uploaded and no control plane is needed. */
  dryRun?: boolean;
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** A project root holds `.claude/`; a path that is itself a `.claude` dir holds `skills/` or `commands/`. */
export function resolveConfigRoot(dir: string, home: string, cwd: string): string {
  const expanded = dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : dir;
  const abs = resolve(cwd, expanded);
  if (isDir(join(abs, '.claude'))) return join(abs, '.claude');
  if (isDir(join(abs, 'skills')) || isDir(join(abs, 'commands'))) return abs;
  throw new PromoteError(`no .claude/skills or .claude/commands under ${abs}`, 1);
}

export async function promoteDirectory(
  dir: string,
  cp: ControlPlaneApi | undefined,
  env: { home?: string; cwd?: string } = {},
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  const configRoot = resolveConfigRoot(dir, env.home ?? homedir(), env.cwd ?? process.cwd());
  let result;
  try {
    result = buildBundle({
      roots: { userDir: configRoot },
      promptsDir: join(configRoot, 'commands'),
      mode: 'attended',
      sandboxImage: 'ghcr.io/rossoctl/moca-remote-worker:latest',
      versions: { pi: 'unknown', harness: 'mocactl' },
    });
  } catch (err) {
    if (err instanceof SecretScanError) {
      const where = err.findings.map((f) => `  ${f.path}:${f.line}  ${f.rule}`).join('\n');
      throw new PromoteError(
        `promote blocked — a credential would reach a shared store:\n${where}\n` +
          'Remove it, then promote again.',
        3,
      );
    }
    throw new PromoteError(err instanceof Error ? err.message : String(err), 1);
  }
  const report = renderPreflight(result.findings);
  if (hasErrors(result.findings)) throw new PromoteError(`preflight found errors:\n${report}`, 2);
  const skills = result.lockfile.skills.map((s) => s.name);
  if (skills.length === 0 && result.promptNames.length === 0) {
    throw new PromoteError(`nothing to promote: no skills or commands under ${configRoot}`, 1);
  }
  if (result.tar.length > MAX_BUNDLE_BYTES) {
    throw new PromoteError(
      `bundle is ${result.tar.length} bytes; the limit is ${MAX_BUNDLE_BYTES} bytes`,
      1,
    );
  }
  const summary: PromoteSummary = {
    digest: result.digest,
    configRoot,
    skills,
    dropped: result.lockfile.dropped.map((d) => ({ name: d.name, reason: d.reason })),
    prompts: result.promptNames,
    report,
    warnings: result.findings.filter((f) => f.severity === 'warn').length,
  };
  opts.onBuilt?.(summary);
  if (opts.dryRun) return { ...summary, uploaded: false, dryRun: true };
  if (!cp) throw new PromoteError('connect to a control plane first', 2);
  const { uploaded } = await cp.putConfigBundle({
    digest: result.digest,
    tar: result.tar.toString('base64'),
  });
  return { ...summary, uploaded };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A bundle digest as the status line and toasts show it: the first 8 hex of `sha256:…`. */
export const shortDigest = (digest: string) => digest.replace(/^sha256:/, '').slice(0, 8);

/** The toast for the session a pending bundle was applied to, so a later /new is not mistaken for it. */
export function describeBundleSession(r: Pick<PromoteResult, 'digest' | 'skills'>): string {
  return `session started with config bundle ${shortDigest(r.digest)} — ${count(r.skills.length, 'skill')}`;
}

/** The one-line TUI toast for a promotion; `dir` is the directory as the user typed it. */
export function describePromotion(
  r: Pick<PromoteResult, 'skills' | 'prompts' | 'warnings' | 'uploaded'>,
  dir: string,
): string {
  const head =
    `promoted ${count(r.skills.length, 'skill')}, ${count(r.prompts.length, 'command')} — ` +
    (r.uploaded ? 'uploaded' : 'unchanged');
  if (!r.warnings) return head;
  return (
    `${head}; ${count(r.warnings, 'warning')} — run \`mocactl promote ${dir} --dry-run\` ` +
    `to see ${r.warnings === 1 ? 'it' : 'them'}`
  );
}
