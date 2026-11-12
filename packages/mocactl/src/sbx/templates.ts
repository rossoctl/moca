import { TOKEN_MARGIN_S, WORKSPACE } from '@moca/sandbox-client';
import { ApiError } from '../api/errors.js';
import { sanitizeRemote } from '../core/sanitize.js';
import type { SbxBuild, SbxHost, SbxReadinessReason } from './api.js';
import { failed, SBX_EXIT, type SbxCtx } from './commands.js';
import { openExec, type ExecFactory } from './exec.js';
import { baselineAtHead } from './push.js';

/**
 * The template reads from mocactl (template lifecycle spec §4): one template and its builds, or one
 * build, and `create --seed`, which runs the served build's own seed; and activation (§6.3): take or
 * renew a lease, wait for the build to be active, release it; and the KVM hosts' slots, start
 * line, memory, idle grace and disk (§6.2, §6.5). Every command has `--json` (the API's answer, never a token).
 */

/** `templates activate --wait`'s limit with no --timeout, in seconds: the floor of a sized one. */
export const ACTIVATE_TIMEOUT_S = 1800;
/** The sized limit's ceiling: a host reporting an outlier start time never makes --wait sit longer. */
export const ACTIVATE_TIMEOUT_CAP_S = 14_400;

/**
 * `activate --wait`'s limit with no --timeout (§6.5): a build queued behind its host's start limit
 * waits (ceil(queuePosition / concurrency) + 1) start times, plus a quarter, from the host's
 * measured start time; never less than ACTIVATE_TIMEOUT_S (a long start line outgrows a fixed
 * limit), never more than ACTIVATE_TIMEOUT_CAP_S. Without a queue position or a measured start
 * time, the floor alone.
 */
export function sizedActivateTimeoutS(
  b: Pick<SbxBuild, 'queued' | 'queuePosition'> | undefined,
  host: SbxHost | undefined,
): number {
  const pos = b?.queued ? b.queuePosition : undefined;
  const conc = host?.start?.concurrency;
  const secs = host?.start?.seconds;
  if (!pos || !conc || !secs) return ACTIVATE_TIMEOUT_S;
  const sized = Math.ceil((Math.ceil(pos / conc) + 1) * secs * 1.25);
  return Math.min(ACTIVATE_TIMEOUT_CAP_S, Math.max(ACTIVATE_TIMEOUT_S, sized));
}
/** Between two reads of a build while waiting for it to be active. */
export const POLL_MS = 5000;

/** Why a leased build is not active yet, for a person. */
const WAITING: Record<string, string> = {
  activating: 'activating: its host is starting its worker',
  inactive: 'inactive: no host agent has reported it yet',
  unavailable: 'unavailable: no host that holds it has a free slot',
  unknown: "unknown: the relay's presence cannot be read",
};

/** Why an `unavailable` build waits, by its readinessReason (template lifecycle spec §6.2). */
const UNAVAILABLE: Record<SbxReadinessReason, string> = {
  not_held: 'unavailable: no host that reports holds its snapshot',
  no_slot: 'unavailable: every host holding it is at its active limit',
  memory: 'unavailable: no host holding it has the memory for its worker now',
  memfile_mismatch:
    "unavailable: every host holding it reports its memory file is not the guest's size (rebuild it)",
};

/**
 * A build's readiness, with its capacity when it is active (`active (running 3, in use 1)`), why
 * it is unavailable (`unavailable (memory)`), its place in its host's start line (`activating
 * (queued at 3)`), or its idle grace (`deactivating (graced until ...)`).
 */
function readinessText(
  b: Pick<
    SbxBuild,
    | 'readiness'
    | 'readinessReason'
    | 'capacity'
    | 'queued'
    | 'queuePosition'
    | 'graced'
    | 'gracedUntil'
  >,
): string {
  if (b.readiness === null) return '';
  const c = b.capacity;
  const cap = c ? ` (running ${c.running}${c.inUse !== null ? `, in use ${c.inUse}` : ''})` : '';
  const extra = [
    ...(!c && b.readinessReason ? [sanitizeRemote(b.readinessReason)] : []),
    ...(b.queued ? [`queued at ${b.queuePosition ?? '?'}`] : []),
    ...(b.queued === false ? ['starting'] : []),
    ...(b.graced
      ? [`graced${b.gracedUntil ? ` until ${new Date(b.gracedUntil * 1000).toISOString()}` : ''}`]
      : []),
  ];
  return `${sanitizeRemote(b.readiness)}${cap}${extra.length ? ` (${extra.join(', ')})` : ''}`;
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
        `${t.readiness !== null ? `  ${readinessText({ readiness: t.readiness, readinessReason: t.readinessReason, capacity: null })}` : ''}\n`,
    );
    for (const b of t.builds) c.io.out(`  ${buildLine(b)}\n`);
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/**
 * `sbx hosts` (§6.2, §6.5): per KVM host, its active slots, its start line (from an agent that
 * reports its start limit), its memory (from an agent that reports it: headroom, the effective
 * floor, a brake), its idle grace (from an agent that sets one) and its disk.
 */
export async function cmdHosts(c: SbxCtx): Promise<number> {
  try {
    const hosts = await c.api.listHosts();
    if (c.json) {
      c.io.out(JSON.stringify(hosts) + '\n');
      return SBX_EXIT.ok;
    }
    if (hosts.length === 0) c.io.out('no host has reported yet\n');
    for (const h of hosts) {
      const m = h.memory;
      const parts = [
        `active ${h.active.used} of ${h.active.limit}`,
        ...(h.start
          ? [
              `start ${h.start.starting ?? '?'} starting, ${h.start.queued ?? '?'} queued (at most ${h.start.concurrency} at once` +
                `${h.start.seconds !== null ? `, ${Math.round(h.start.seconds)} s each` : ''})`,
            ]
          : []),
        ...(m
          ? [
              `memory ${m.headroomMib} MiB headroom of ${m.totalMib} (floor ${m.floorMib})` +
                `${m.brake ? `, brake: ${sanitizeRemote(m.brake)}` : ''}` +
                `${m.memfileMismatch.length ? `, ${m.memfileMismatch.length} memory file mismatch` : ''}`,
            ]
          : []),
        ...(h.idleGraceSeconds !== undefined
          ? [`grace ${h.idleGraceSeconds} s (${h.graced ?? 0} graced)`]
          : []),
        `disk ${h.disk.freeGb} GB free (floor ${h.disk.floorGb})`,
      ];
      c.io.out(`${sanitizeRemote(h.id).padEnd(16)} ${parts.join('; ')}\n`);
    }
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
 * refusal fails at once. A wait past --timeout exits 5. Without --timeout the limit is
 * ACTIVATE_TIMEOUT_S, raised once the build is read queued in its host's start line to what the
 * line implies (sizedActivateTimeoutS), saying so; --timeout always wins.
 */
export async function cmdActivate(
  c: SbxCtx,
  id: string,
  opts: { build?: string; leaseSeconds?: number; wait: boolean; timeoutS?: number },
): Promise<number> {
  let timeoutS = opts.timeoutS ?? ACTIVATE_TIMEOUT_S;
  const start = c.rt.now();
  let end = start + timeoutS * 1000;
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
        say(
          err.reason === 'memory'
            ? 'no host holding it has the memory for its worker now'
            : 'no active slot: every host holding it is at its limit with leased builds',
        );
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
    // No --timeout: the limit is sized from the host's start line (best effort: without the hosts
    // block, the floor stands).
    let host: SbxHost | undefined;
    if (opts.timeoutS === undefined && lease.host !== null) {
      try {
        host = (await c.api.listHosts()).find((h) => h.id === lease.host);
      } catch {
        host = undefined;
      }
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
      if (b && opts.timeoutS === undefined) {
        const sized = sizedActivateTimeoutS(b, host);
        if (sized > timeoutS) {
          timeoutS = sized;
          end = start + sized * 1000;
          c.io.err(
            `${sanitizeRemote(id)}: queued at ${b.queuePosition}; waiting up to ${sized} s (sized from the host's start line` +
              `${sized >= ACTIVATE_TIMEOUT_CAP_S ? `, capped at ${ACTIVATE_TIMEOUT_CAP_S} s; pass --timeout for longer` : ''})`,
          );
        }
      }
      if (b) {
        const why =
          b.readiness === 'unavailable' && b.readinessReason
            ? UNAVAILABLE[b.readinessReason]
            : b.readiness === 'activating' && b.queued
              ? `activating: queued at ${b.queuePosition ?? '?'} in its host's start line`
              : undefined;
        say(why ?? WAITING[b.readiness ?? ''] ?? sanitizeRemote(b.readiness ?? 'no readiness'));
      }
      const left = end - c.rt.now();
      if (left <= 0) return timedOut(c, `${id} ${lease.buildId} to be active`, timeoutS);
      await c.rt.sleep(Math.min(POLL_MS, left), c.signal);
      if (c.signal?.aborted) return SBX_EXIT.failed;
    }
  } catch (err) {
    return failed(c, err);
  }
}

/**
 * `templates deactivate ID [--stop-now]` (§6.3): release the caller's leases on the template;
 * --stop-now skips the host's idle grace (§6.5), so the worker stops at the host's next poll.
 */
export async function cmdDeactivate(c: SbxCtx, id: string, stopNow = false): Promise<number> {
  try {
    const r = await c.api.deactivateTemplate(id, stopNow ? { stopNow: true } : {});
    if (c.json) c.io.out(JSON.stringify(r) + '\n');
    else
      c.io.out(
        `${sanitizeRemote(r.templateId)}: released ${r.released} lease${r.released === 1 ? '' : 's'}` +
          `${stopNow ? ', stopped now (no idle grace)' : ''}\n`,
      );
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}
