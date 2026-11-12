import { TOKEN_MARGIN_S, WORKSPACE } from '@moca/sandbox-client';
import { sanitizeRemote } from '../core/sanitize.js';
import type { SbxBuild } from './api.js';
import { failed, SBX_EXIT, type SbxCtx } from './commands.js';
import { openExec, type ExecFactory } from './exec.js';
import { baselineAtHead } from './push.js';

/**
 * The template reads from mocactl (template lifecycle spec §4): one template and its builds, or one
 * build, and `create --seed`, which runs the served build's own seed. Every command has `--json`
 * (the API's answer, never a token).
 */

/** A build's readiness, with its capacity when it is active: `active (running 3, in use 1)`. */
function readinessText(b: Pick<SbxBuild, 'readiness' | 'capacity'>): string {
  if (b.readiness === null) return '';
  const c = b.capacity;
  const cap = c ? ` (running ${c.running}${c.inUse !== null ? `, in use ${c.inUse}` : ''})` : '';
  return `${sanitizeRemote(b.readiness)}${cap}`;
}

/** One build, for a person. */
function buildLine(b: SbxBuild): string {
  return [
    sanitizeRemote(b.buildId),
    sanitizeRemote(b.status),
    ...(b.readiness !== null ? [readinessText(b)] : []),
    ...(b.tags.length ? [`tags ${b.tags.map(sanitizeRemote).join(',')}`] : []),
  ].join('  ');
}

/** `templates show ID [--build B]`: a template and its builds, or one build. */
export async function cmdShowTemplate(c: SbxCtx, id: string, build?: string): Promise<number> {
  try {
    if (build !== undefined) {
      const b = await c.api.getTemplateBuild(id, build);
      c.io.out(c.json ? JSON.stringify(b) + '\n' : buildLine(b) + '\n');
      return SBX_EXIT.ok;
    }
    const t = await c.api.getTemplate(id);
    if (c.json) {
      c.io.out(JSON.stringify(t) + '\n');
      return SBX_EXIT.ok;
    }
    c.io.out(
      `${sanitizeRemote(t.id)}  owner ${sanitizeRemote(t.owner ?? 'the deployment')}  ${sanitizeRemote(t.visibility)}` +
        `  ${sanitizeRemote(t.onboarding ?? 'no build')}` +
        `${t.readiness !== null ? `  ${sanitizeRemote(t.readiness)}` : ''}\n`,
    );
    for (const b of t.builds) c.io.out(`  ${buildLine(b)}\n`);
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** What `create --seed` did: the seed's exit, and the workspace it left. */
export interface SeedResult {
  seed: string;
  exitCode: number;
  /** Null when /workspace is not a git repository after the seed. */
  clean: boolean | null;
  head: string | null;
}

/** The workspace check after a seed: is it a repository, is its tree clean, and its HEAD. */
const WORKSPACE_CHECK =
  'cd /workspace && if git rev-parse --git-dir >/dev/null 2>&1; then ' +
  'printf "dirty=%s\\n" "$(git status --porcelain | wc -l | tr -d " ")"; ' +
  'printf "head=%s\\n" "$(git rev-parse HEAD 2>/dev/null)"; else echo nogit; fi';

/**
 * `create --seed`: the build's `spec.seed`, run as the new sandbox's first command (the sandbox
 * profile leaves the seed to the client), then the workspace checked for a clean tree. The build is
 * the one the create was served (its `buildId`), read from GET /v1/templates/{id}, never the newest.
 * A clean git tree becomes the sbx baseline. Returns the result, or the line saying why the seed
 * failed (the sandbox stays, for the caller to look into or delete).
 */
export async function seedSandbox(
  c: SbxCtx,
  sandbox: { id: string; template: string; buildId?: string | null },
  factory?: ExecFactory,
): Promise<SeedResult | string> {
  const id = sandbox.template.split(/[@:]/)[0]!;
  const t = await c.api.getTemplate(id);
  const b =
    t.builds.find((x) => sandbox.buildId && x.buildId === sandbox.buildId) ??
    t.builds.find((x) => x.buildId === t.tags.default);
  const seed = b?.spec?.seed;
  if (seed === undefined) return `the build of ${sanitizeRemote(id)} names no seed`;
  if (seed === '') return { seed, exitCode: 0, clean: null, head: null };
  const x = await openExec(c.api, sandbox.id, factory);
  try {
    const timeoutS = x.lifetimeS - TOKEN_MARGIN_S > 0 ? x.lifetimeS - TOKEN_MARGIN_S : undefined;
    const r = await x.exec(seed, {
      ...(timeoutS !== undefined ? { timeoutS } : {}),
      signal: c.signal,
    });
    if (r.exitCode !== 0)
      return `the seed exited ${r.exitCode}: ${sanitizeRemote(r.stderr.toString().trim().slice(-400)) || 'no stderr'}`;
    const w = (
      await x.exec(WORKSPACE_CHECK, { timeoutS: 120, signal: c.signal })
    ).stdout.toString();
    const git = !/^nogit$/m.test(w);
    const dirty = Number(/^dirty=(\d+)$/m.exec(w)?.[1] ?? '0');
    const head = /^head=([0-9a-f]{40,64})$/m.exec(w)?.[1] ?? null;
    if (git && dirty > 0)
      return `after the seed, /workspace has ${dirty} changed or untracked paths: not a clean tree`;
    // The seed's clean tree is the template's: the baseline `pull` and `rm` measure changes from.
    if (git && head !== null) await baselineAtHead(x.exec, WORKSPACE, { signal: c.signal });
    return { seed, exitCode: 0, clean: git ? dirty === 0 : null, head };
  } finally {
    x.close();
  }
}
