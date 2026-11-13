import { TOKEN_MARGIN_S, WORKSPACE } from '@moca/sandbox-client';
import { ApiError } from '../api/errors.js';
import { sanitizeRemote } from '../core/sanitize.js';
import type { SbxBuild } from './api.js';
import { failed, SBX_EXIT, type SbxCtx } from './commands.js';
import { openExec, type ExecFactory } from './exec.js';
import { baselineAtHead } from './push.js';

/**
 * The template reads from mocactl (template lifecycle spec §4): one template and its builds, or one
 * build, and `create --seed`, which runs the served build's own seed; activation (§6.3): take or
 * renew a lease, wait for the build to be active, release it; and retire (§5.1), waiting until no
 * host holds the build. Every command has `--json` (the API's answer, never a token).
 */

/** `templates activate --wait`'s limit with no --timeout, in seconds. */
export const ACTIVATE_TIMEOUT_S = 1800;
/** `templates retire --wait`'s limit with no --timeout, in seconds. */
export const RETIRE_TIMEOUT_S = 300;
/** Between two reads of a build while waiting for it to be active, or gone from every host. */
export const POLL_MS = 5000;

/** Why a leased build is not active yet, for a person. */
const WAITING: Record<string, string> = {
  activating: 'activating: its host is starting its worker',
  inactive: 'inactive: no host agent has reported it yet',
  unavailable: 'unavailable: no host that holds it has a free slot',
  unknown: "unknown: the relay's presence cannot be read",
};

/** A build's readiness, with its capacity when it is active: `active (running 3, in use 1)`. */
function readinessText(b: Pick<SbxBuild, 'readiness' | 'capacity'>): string {
  if (b.readiness === null) return '';
  const c = b.capacity;
  const cap = c
    ? ` (running ${c.running ?? '?'}${c.inUse !== null ? `, in use ${c.inUse}` : ''})`
    : '';
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

/** A wait ran out: exit 5, saying what was waited for. */
function timedOut(c: SbxCtx, what: string, timeoutS: number): number {
  c.io.err(`sbx: timed out after ${timeoutS} s waiting for ${sanitizeRemote(what)}`);
  return SBX_EXIT.timedOut;
}

/** A failure worth polling through: the control plane unreachable for a moment, or a 5xx. */
const transient = (err: unknown) =>
  err instanceof ApiError && (err.status === 0 || err.status >= 500);

/**
 * `templates activate ID [--build B] [--lease S] [--wait [--timeout S]]` (§6.3): take or renew the
 * caller's lease. Without --wait, the lease answer. With it, a `409 no_active_slot` is retried after
 * its Retry-After, and the build is read until it is `active`, saying why it waits; any other
 * refusal fails at once. A wait past --timeout (default ACTIVATE_TIMEOUT_S) exits 5.
 */
export async function cmdActivate(
  c: SbxCtx,
  id: string,
  opts: { build?: string; leaseSeconds?: number; wait: boolean; timeoutS?: number },
): Promise<number> {
  const timeoutS = opts.timeoutS ?? ACTIVATE_TIMEOUT_S;
  const end = c.rt.now() + timeoutS * 1000;
  const body = {
    ...(opts.build !== undefined ? { build: opts.build } : {}),
    ...(opts.leaseSeconds !== undefined ? { leaseSeconds: opts.leaseSeconds } : {}),
  };
  try {
    let said = '';
    const say = (why: string) => {
      if (why !== said) c.io.err(`${sanitizeRemote(id)}: waiting: ${why}`);
      said = why;
    };
    let lease;
    for (;;) {
      try {
        lease = await c.api.activateTemplate(id, body);
        break;
      } catch (err) {
        if (!(opts.wait && err instanceof ApiError && err.code === 'no_active_slot')) throw err;
        say('no active slot: every host holding it is at its limit with leased builds');
        const left = end - c.rt.now();
        if (left <= 0) return timedOut(c, `an active slot for ${id}`, timeoutS);
        await c.rt.sleep(Math.min(Math.max(1, err.retryAfterS ?? 30) * 1000, left), c.signal);
        if (c.signal?.aborted) throw err;
      }
    }
    const until = new Date(lease.leaseUntil * 1000).toISOString();
    if (!opts.wait) {
      if (c.json) c.io.out(JSON.stringify(lease) + '\n');
      else
        c.io.out(
          `${sanitizeRemote(lease.templateId)} ${sanitizeRemote(lease.buildId)} leased until ${until}` +
            `${lease.host ? ` on ${sanitizeRemote(lease.host)}` : ''}\n`,
        );
      return SBX_EXIT.ok;
    }
    for (;;) {
      let b: SbxBuild | undefined;
      try {
        b = await c.api.getTemplateBuild(id, lease.buildId);
      } catch (err) {
        if (!transient(err)) throw err;
      }
      if (b?.readiness === 'active') {
        if (c.json) c.io.out(JSON.stringify({ ...lease, readiness: b.readiness }) + '\n');
        else
          c.io.out(
            `${sanitizeRemote(id)} ${sanitizeRemote(b.buildId)} active, leased until ${until}\n`,
          );
        return SBX_EXIT.ok;
      }
      if (b && b.status !== 'registered') {
        c.io.err(
          `sbx: ${sanitizeRemote(id)} ${sanitizeRemote(b.buildId)} cannot become active: it is ${sanitizeRemote(b.status)}`,
        );
        return SBX_EXIT.failed;
      }
      if (b) say(WAITING[b.readiness ?? ''] ?? sanitizeRemote(b.readiness ?? 'no readiness'));
      const left = end - c.rt.now();
      if (left <= 0) return timedOut(c, `${id} ${lease.buildId} to be active`, timeoutS);
      await c.rt.sleep(Math.min(POLL_MS, left), c.signal);
      if (c.signal?.aborted) return SBX_EXIT.failed;
    }
  } catch (err) {
    return failed(c, err);
  }
}

/** `templates deactivate ID` (§6.3): release the caller's leases on the template. */
export async function cmdDeactivate(c: SbxCtx, id: string): Promise<number> {
  try {
    const r = await c.api.deactivateTemplate(id);
    if (c.json) c.io.out(JSON.stringify(r) + '\n');
    else
      c.io.out(
        `${sanitizeRemote(r.templateId)}: released ${r.released} lease${r.released === 1 ? '' : 's'}\n`,
      );
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/**
 * `templates retire ID [--build B] [--reason T] [--wait [--timeout S]]` (§5.1): retire the template
 * (every build of it) or build B, and print each build retired. With --wait, then read each build
 * until it is `retired` and its worker no longer runs (`capacity` null: the host stopped it, after
 * the wanted state's `stop`), saying so while it still runs; `running` null, presence unreadable,
 * is waited out too, never taken as stopped. Only a host agent that holds the build stops its
 * worker (the wanted state's `stop` lists the builds a host holds), so a build no host holds has
 * nothing to wait for: `heldBy` null (no host agents; or absent, from an older control plane) or
 * empty (no host holds it, such as an imported template whose worker an operator runs). Then a
 * worker that still runs is said to be not host-managed, to be stopped where it runs. A wait past
 * --timeout (default RETIRE_TIMEOUT_S) exits 5. Waiting for the snapshot's removal from every host
 * comes with the host's removal step (#743).
 */
export async function cmdRetire(
  c: SbxCtx,
  id: string,
  opts: { build?: string; reason?: string; wait: boolean; timeoutS?: number },
): Promise<number> {
  const timeoutS = opts.timeoutS ?? RETIRE_TIMEOUT_S;
  try {
    const r = await c.api.retireTemplate(id, {
      ...(opts.build !== undefined ? { build: opts.build } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
    const builds = r.builds ?? [{ build: r.build ?? opts.build ?? '', record: r.record ?? null }];
    if (c.json) c.io.out(JSON.stringify(r) + '\n');
    else
      for (const b of builds)
        c.io.out(
          `retired ${sanitizeRemote(r.templateId)} ${sanitizeRemote(b.build)}` +
            `${b.record ? '' : ' (already retired)'}\n`,
        );
    if (!opts.wait) return SBX_EXIT.ok;
    const end = c.rt.now() + timeoutS * 1000;
    for (const { build } of builds) {
      let said = '';
      for (;;) {
        let b: SbxBuild | undefined;
        try {
          b = await c.api.getTemplateBuild(r.templateId, build);
        } catch (err) {
          if (!transient(err)) throw err;
        }
        if (b && b.status === 'retired' && b.capacity === null) {
          c.io.err(
            `${sanitizeRemote(r.templateId)} ${sanitizeRemote(build)}: retired, its worker stopped`,
          );
          break;
        }
        // No host holds it (heldBy null, absent or empty): no host agent will stop its worker.
        if (b && b.status === 'retired' && (b.heldBy ?? []).length === 0) {
          c.io.err(
            `${sanitizeRemote(r.templateId)} ${sanitizeRemote(build)}: retired; no host agent ` +
              'holds it, so its worker is not host-managed: stop it where it runs',
          );
          break;
        }
        if (b) {
          const inUse = b.capacity?.inUse;
          const why =
            b.status !== 'retired'
              ? sanitizeRemote(b.status)
              : b.capacity?.running === null
                ? "retired, its worker's state cannot be read; still waiting"
                : `retired, its worker still runs${typeof inUse === 'number' ? ` (${inUse} in use)` : ''}`;
          if (why !== said)
            c.io.err(`${sanitizeRemote(r.templateId)} ${sanitizeRemote(build)}: ${why}`);
          said = why;
        }
        const left = end - c.rt.now();
        if (left <= 0) return timedOut(c, `${r.templateId} ${build} to stop its worker`, timeoutS);
        await c.rt.sleep(Math.min(POLL_MS, left), c.signal);
        if (c.signal?.aborted) return SBX_EXIT.failed;
      }
    }
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}
