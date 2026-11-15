import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { TOKEN_MARGIN_S, WORKSPACE } from '@moca/sandbox-client';
import { ApiError } from '../api/errors.js';
import { describeError } from '../core/messages.js';
import { sanitizeRemote } from '../core/sanitize.js';
import type {
  SbxBuild,
  SbxHost,
  SbxPolicyView,
  SbxQueued,
  SbxReadinessReason,
  SbxTemplateCreate,
  SbxTemplateFull,
} from './api.js';
import { failed, refusalText, SBX_EXIT, type SbxCtx } from './commands.js';
import { dryRun } from './dry-run.js';
import { openExec, type ExecFactory } from './exec.js';
import { noticingExec } from './notices.js';
import { baselineAtHead } from './push.js';

/**
 * The template commands of mocactl (template lifecycle spec §4, §8): the reads a client makes
 * before a create (quota, policy), one template and its builds or one build, create and follow a
 * build, cancel it, and `create --seed`, which runs the served build's own seed; activation (§6.3):
 * take or renew a lease, wait for the build to be active, release it; retire (§5.1), waiting until
 * no host holds the build; and the KVM hosts' slots, start line, memory, idle grace and disk (§6.2,
 * §6.5). Every command has `--json` (the API's answer, never a token); a wait that runs out of time
 * exits 5.
 */

/** `templates follow`'s default bound, in seconds; also the bound of a create's wait for a queue slot. */
export const FOLLOW_TIMEOUT_S = 3600;
/** Between two polls of a build, in milliseconds. */
export const POLL_MS = 5000;
/** `templates activate --wait`'s limit with no --timeout, in seconds: the floor of a sized one. */
export const ACTIVATE_TIMEOUT_S = 1800;
/** `templates retire --wait`'s limit with no --timeout, in seconds. */
// Past the 600 s a host keeps shipping an ended sandbox's egress before it may remove the build,
// plus a few host polls.
export const RETIRE_TIMEOUT_S = 900;
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

/** Why a leased build is not active yet, for a person. */
const WAITING: Record<string, string> = {
  activating: 'activating: its host is starting its worker',
  inactive: 'inactive: no host agent has reported it yet',
  unavailable: 'unavailable: no host that holds it has a free slot',
  unknown: "unknown: the relay's presence cannot be read",
};
/** A wait for a queue slot (`429 buildsQueued`) when the answer names no Retry-After. */
const QUEUE_SLOT_WAIT_MS = 30_000;

/** The statuses a build ends in: `templates follow` stops there. A cancelled build is `failed`. */
const BUILD_ENDS = new Set(['registered', 'failed', 'rejected', 'retired']);

const clock = (c: SbxCtx) => ({ sleep: c.sleep ?? c.rt.sleep, now: c.now ?? c.rt.now });

/** A Ctrl-C during a template command's wait, or between its requests: never a refusal. */
class Interrupted extends Error {
  constructor() {
    super('interrupted');
  }
}

/** The end of an interrupted command: exit 130, nothing more sent. */
const interrupted = (c: SbxCtx) => {
  c.io.err(`sbx: interrupted (exit ${SBX_EXIT.interrupted})`);
  return SBX_EXIT.interrupted;
};

/** A failure worth polling through: the control plane unreachable for a moment, or a 5xx. */
const transient = (err: unknown) =>
  err instanceof ApiError && (err.status === 0 || err.status >= 500);

/** `GET /v1/quota`'s one row: `buildsQueued   3 of 10`. */
const limitLine = (name: string, v: { limit: number; used: number } | undefined) =>
  v ? `${name.padEnd(14)} ${v.used} of ${v.limit}\n` : '';

/** `sbx quota`: the caller's template quotas and use, and the live-sandbox cap. */
export async function cmdQuota(c: SbxCtx): Promise<number> {
  try {
    const q = await c.api.getQuota();
    if (c.json) c.io.out(JSON.stringify(q) + '\n');
    else
      c.io.out(
        `${sanitizeRemote(q.subject)}\n` +
          limitLine('templates', q.templates) +
          limitLine('buildsQueued', q.buildsQueued) +
          limitLine('active', q.active) +
          limitLine('sandboxes', q.sandboxes),
      );
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** `sbx policy`: each profile (envelope, egress, rules), the allowed registries, the policy's digest. */
export async function cmdPolicy(c: SbxCtx): Promise<number> {
  try {
    const v = await c.api.getPolicy();
    if (c.json) {
      c.io.out(JSON.stringify(v) + '\n');
      return SBX_EXIT.ok;
    }
    const p = v.policy;
    for (const [name, pr] of Object.entries(p.profiles).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const e = pr.envelope;
      c.io.out(
        `${sanitizeRemote(name).padEnd(16)}${name === p.defaultProfile ? ' (default)' : ''} ` +
          `guest <= ${e.maxGuestMb} MiB, vcpus <= ${e.maxVcpus}, workspace <= ${e.maxWorkspaceMb} MiB` +
          (e.exact ? ` (exactly ${e.exact.guestMb} MiB, ${e.exact.vcpus} vCPUs)` : '') +
          `; ${pr.requires.includes('X11') ? 'no egress' : 'egress allowed'}` +
          `; requires ${pr.requires.length ? pr.requires.map(sanitizeRemote).join(' ') : 'nothing'}\n`,
      );
    }
    c.io.out(`registries ${p.allowedRegistries.map(sanitizeRemote).join(', ') || 'none'}\n`);
    c.io.out(
      `trusted gate records ${p.trustedGateRecords.length}; quota templates ${p.quota.templates}, ` +
        `builds queued ${p.quota.buildsQueued}, active ${p.quota.active}\n`,
    );
    c.io.out(`policy ${sanitizeRemote(v.digest)} (record ${sanitizeRemote(v.record)})\n`);
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** A build's reason in one line: `step probe, rule X1: <message>`. */
function reasonText(r: SbxBuild['reason']): string {
  if (!r) return '';
  const tags = [
    ...(r.step ? [`step ${sanitizeRemote(r.step)}`] : []),
    ...(r.rule ? [`rule ${sanitizeRemote(r.rule)}`] : []),
  ];
  return `${tags.join(', ')}${tags.length ? ': ' : ''}${sanitizeRemote(r.message)}`;
}

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
  const cap = c
    ? ` (running ${c.running ?? '?'}${c.inUse !== null ? `, in use ${c.inUse}` : ''})`
    : '';
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

/** One build, for a person: its handle beside its build id while they differ. */
function buildLine(b: SbxBuild): string {
  const id =
    b.handle === undefined || b.handle === b.buildId ? b.buildId : `${b.handle} ${b.buildId}`;
  return [
    sanitizeRemote(id),
    sanitizeRemote(b.status),
    ...(b.readiness !== null ? [readinessText(b)] : []),
    ...(b.tags.length ? [`tags ${b.tags.map(sanitizeRemote).join(',')}`] : []),
    ...(b.reason ? [reasonText(b.reason)] : []),
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

/** The build a create answered: the last segment of its `build` path (its handle, or its buildId). */
export const handleOf = (q: SbxQueued): string => q.build.split('/').pop() ?? q.build;

/** A build's name to follow it by: its handle, or its buildId for an imported build. */
const buildRef = (b: SbxBuild): string => b.handle ?? b.buildId;

/** The newest build of a template (the API lists them newest first). */
async function newestBuild(c: SbxCtx, id: string): Promise<string | undefined> {
  const t = await c.api.getTemplate(id);
  const b = t.builds[0];
  return b ? buildRef(b) : undefined;
}

/**
 * Polls a build until `until` holds, saying each status it passes on stderr; transient failures
 * (5xx, unreachable) are polled through, any other is thrown. Returns the last build read, or
 * 'timeout'.
 */
async function pollBuild(
  c: SbxCtx,
  id: string,
  build: string,
  timeoutS: number,
  until: (b: SbxBuild) => boolean,
): Promise<SbxBuild | 'timeout'> {
  const { sleep, now } = clock(c);
  const end = now() + timeoutS * 1000;
  let said = '';
  for (;;) {
    try {
      const b = await c.api.getTemplateBuild(id, build);
      if (until(b)) return b;
      if (b.status !== said)
        c.io.err(`${sanitizeRemote(id)} ${sanitizeRemote(build)}: ${sanitizeRemote(b.status)}`);
      said = b.status;
    } catch (err) {
      if (!transient(err)) throw err;
      c.io.err(`sbx: ${describeError(err)}; polling again`);
    }
    const left = end - now();
    if (left <= 0) return 'timeout';
    await sleep(Math.min(POLL_MS, left), c.signal);
    if (c.signal?.aborted) throw new Interrupted();
  }
}

/** A wait ran out: exit 5, saying what was waited for. */
const timedOut = (c: SbxCtx, what: string, s: number) => {
  c.io.err(
    `sbx: timed out after ${s} s waiting for ${sanitizeRemote(what)} (exit ${SBX_EXIT.timedOut})`,
  );
  return SBX_EXIT.timedOut;
};

/** The end of a followed build: 0 only when registered, the reason printed otherwise. */
function buildEnd(c: SbxCtx, id: string, b: SbxBuild): number {
  if (c.json) c.io.out(JSON.stringify(b) + '\n');
  else c.io.out(`${sanitizeRemote(id)} ${buildLine(b)}\n`);
  if (b.status === 'registered') return SBX_EXIT.ok;
  c.io.err(
    `sbx: ${sanitizeRemote(id)} ${sanitizeRemote(buildRef(b))} ${b.status === 'failed' && b.reason?.step === 'cancelled' ? 'was cancelled' : sanitizeRemote(b.status)}` +
      `${b.reason ? `: ${reasonText(b.reason)}` : ''}`,
  );
  return SBX_EXIT.failed;
}

/**
 * `templates follow ID [--build B] [--timeout S]`: until the build ends; exit 0 only on registered,
 * 5 past the timeout, 130 on Ctrl-C (the build goes on: `templates cancel` withdraws it).
 */
export async function cmdFollowTemplate(
  c: SbxCtx,
  id: string,
  opts: { build?: string; timeoutS?: number },
): Promise<number> {
  const timeoutS = opts.timeoutS ?? FOLLOW_TIMEOUT_S;
  try {
    const build = opts.build ?? (await newestBuild(c, id));
    if (build === undefined) {
      c.io.err(`sbx: ${sanitizeRemote(id)} has no build to follow`);
      return SBX_EXIT.failed;
    }
    const b = await pollBuild(c, id, build, timeoutS, (x) => BUILD_ENDS.has(x.status));
    if (b === 'timeout') return timedOut(c, `${id} ${build} to end`, timeoutS);
    return buildEnd(c, id, b);
  } catch (err) {
    if (err instanceof Interrupted || c.signal?.aborted) return interrupted(c);
    return failed(c, err);
  }
}

/** `templates cancel ID --build B`: withdraw a queued, building or probing build. */
export async function cmdCancelBuild(c: SbxCtx, id: string, build: string): Promise<number> {
  try {
    const r = await c.api.cancelTemplateBuild(id, build);
    if (c.json) c.io.out(JSON.stringify(r) + '\n');
    else c.io.out(`cancelled ${sanitizeRemote(r.templateId)} ${sanitizeRemote(r.build)}\n`);
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}

/** The most a create's gate record may hold: the create routes take a body of at most 1 MiB. */
export const GATE_RECORD_MAX_BYTES = 1024 * 1024;

/** What a create reads from its files: one spec (or a gate record's `template` block). */
export interface CreateInput {
  file: string;
  body: SbxTemplateCreate & { id: string };
}

/**
 * Reads a create's inputs: F is a spec, or a gate record whose `template` block is the spec. The id
 * and the image default to the spec's own; given, they must equal them (M7.spec_id, M7.spec_image).
 * The gate record (with one spec only, at most GATE_RECORD_MAX_BYTES) is read as text and must
 * round-trip byte for byte, since its sha256 is what the policy trusts. Returns the bodies, or the
 * line saying why not.
 */
export function readCreateInputs(
  files: string[],
  o: { id?: string; image?: string; profile?: string; visibility?: string; gateRecord?: string },
): CreateInput[] | string {
  let gateRecord: string | undefined;
  // A gate record is one image's: it goes with one spec, not with each of several.
  if (o.gateRecord !== undefined && files.length > 1)
    return "--gate-record is one image's record: give one --spec with it";
  if (o.gateRecord !== undefined) {
    let raw: Buffer;
    try {
      // Sized before it is read, through the one handle it is read from (so the size checked is the
      // file read): a wrong file (an image tarball) is refused, not loaded.
      const fd = openSync(o.gateRecord, 'r');
      try {
        const size = fstatSync(fd).size;
        if (size > GATE_RECORD_MAX_BYTES)
          return `--gate-record ${o.gateRecord} is ${size} bytes: a gate record is at most 1 MiB (the create's body limit)`;
        raw = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      return `cannot read --gate-record ${o.gateRecord}: ${(err as Error).message}`;
    }
    gateRecord = raw.toString('utf8');
    if (!Buffer.from(gateRecord, 'utf8').equals(raw))
      return `--gate-record ${o.gateRecord} is not UTF-8 text: it could not be sent byte for byte`;
  }
  if (files.length > 1 && (o.id !== undefined || o.image !== undefined))
    return '--id and --image name one template: give one --spec with them';
  const out: CreateInput[] = [];
  for (const file of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      return `cannot read --spec ${file}: ${(err as Error).message}`;
    }
    const rec =
      doc && typeof doc === 'object' && !Array.isArray(doc)
        ? (doc as Record<string, unknown>)
        : null;
    const tpl = rec?.template;
    const spec =
      tpl && typeof tpl === 'object' && !Array.isArray(tpl)
        ? (tpl as Record<string, unknown>)
        : rec;
    if (!spec) return `--spec ${file} is not a JSON object`;
    const id = o.id ?? (typeof spec.id === 'string' ? spec.id : undefined);
    const image = o.image ?? (typeof spec.image === 'string' ? spec.image : undefined);
    if (id === undefined) return `--spec ${file} names no id: pass --id ID`;
    if (image === undefined) return `--spec ${file} names no image: pass --image REF`;
    out.push({
      file,
      body: {
        id,
        image,
        spec,
        ...(o.profile !== undefined ? { profile: o.profile } : {}),
        ...(o.visibility !== undefined ? { visibility: o.visibility } : {}),
        ...(gateRecord !== undefined ? { gateRecord } : {}),
      },
    });
  }
  return out;
}

/** M7's id and image checks, the ones a create makes before a request even without --dry-run. */
function specMismatch(b: CreateInput['body']): string | undefined {
  if (b.spec.id !== undefined && b.spec.id !== b.id)
    return `refused by policy rule M7.spec_id: spec.id must be the create's id (${sanitizeRemote(String(b.spec.id))}, not ${sanitizeRemote(b.id)})`;
  if (b.spec.image !== undefined && b.spec.image !== b.image)
    return "refused by policy rule M7.spec_image: spec.image must be the create's image";
  return undefined;
}

/** `templates create … --dry-run`: the local checks, against the policy's profiles (`sbx policy`). */
export async function cmdDryRun(c: SbxCtx, inputs: CreateInput[]): Promise<number> {
  let policy: SbxPolicyView;
  try {
    policy = await c.api.getPolicy();
  } catch (err) {
    return failed(c, err);
  }
  let code: number = SBX_EXIT.ok;
  for (const { file, body } of inputs) {
    const r = dryRun(
      {
        id: body.id,
        image: body.image,
        spec: body.spec,
        ...(body.profile !== undefined ? { profile: body.profile } : {}),
        ...(body.gateRecord !== undefined ? { gateRecord: body.gateRecord } : {}),
      },
      policy.policy,
    );
    if (c.json) c.io.out(JSON.stringify({ file, id: body.id, ...r }) + '\n');
    else if (!r.failed)
      c.io.out(
        `${sanitizeRemote(body.id)}: passes the local checks (${sanitizeRemote(r.profile)})\n`,
      );
    // The notes and messages carry the policy's text (profile names, envelope values) and the
    // spec's: remote or file text, sanitized before it reaches a terminal.
    for (const n of r.notes) c.io.err(`sbx: ${sanitizeRemote(body.id)}: ${sanitizeRemote(n)}`);
    if (r.failed) {
      c.io.err(
        `sbx: ${sanitizeRemote(body.id)} (${sanitizeRemote(file)}): would be refused by policy rule ${sanitizeRemote(r.failed.rule)}: ${sanitizeRemote(r.failed.message ?? '')}`,
      );
      code = SBX_EXIT.failed;
    }
  }
  return code;
}

/**
 * One create, waiting out `429 quota_exceeded {quota: buildsQueued}` for a queue slot until `end`.
 * `waiting` is how many creates, this one included, wait behind the quota. Any other refusal is
 * thrown; a Ctrl-C throws `Interrupted`, and no POST is sent after it. Returns the answer, or
 * 'timeout'.
 */
async function createOne(
  c: SbxCtx,
  body: CreateInput['body'],
  build: string | undefined,
  end: number,
  waiting: number,
): Promise<SbxQueued | 'timeout'> {
  const { sleep, now } = clock(c);
  let said = false;
  for (;;) {
    if (c.signal?.aborted) throw new Interrupted();
    try {
      return build !== undefined
        ? await c.api.createTemplateBuild(build, body)
        : await c.api.createTemplate(body);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 429 && err.quota === 'buildsQueued'))
        throw err;
      if (!said) c.io.err(`${waiting} waiting for a queue slot (your buildsQueued quota is full)`);
      said = true;
      const left = end - now();
      if (left <= 0) return 'timeout';
      await sleep(
        Math.min(Math.max(1, err.retryAfterS ?? QUEUE_SLOT_WAIT_MS / 1000) * 1000, left),
        c.signal,
      );
      if (c.signal?.aborted) throw new Interrupted();
    }
  }
}

/**
 * `templates create --spec F …` and `templates build ID --spec F`: each spec posted once, in
 * order, its answer printed (one JSON object per line with --json). A create on the caller's own
 * id is a new build of it (or the build of the same inputs, `reused`); a `409 template_exists` is a
 * refusal, saying whose the id is.
 */
export async function cmdCreateTemplates(
  c: SbxCtx,
  inputs: CreateInput[],
  opts: { build?: string; timeoutS?: number },
): Promise<number> {
  for (const { body } of inputs) {
    const bad = specMismatch(body);
    if (bad) {
      c.io.err(`sbx: ${bad}`);
      return SBX_EXIT.failed;
    }
  }
  const timeoutS = opts.timeoutS ?? FOLLOW_TIMEOUT_S;
  const end = clock(c).now() + timeoutS * 1000;
  let code: number = SBX_EXIT.ok;
  for (const [i, { body }] of inputs.entries()) {
    // A Ctrl-C stops the loop: the specs not yet posted are not posted.
    if (c.signal?.aborted) return interrupted(c);
    const id = opts.build ?? body.id;
    try {
      const q = await createOne(c, body, opts.build, end, inputs.length - i);
      if (q === 'timeout') return timedOut(c, `a queue slot for ${id}`, timeoutS);
      if (c.json) c.io.out(JSON.stringify(q) + '\n');
      else
        c.io.out(
          `${sanitizeRemote(q.templateId)} ${sanitizeRemote(handleOf(q))} ${sanitizeRemote(q.status)}${q.reused ? ' (reused: the same inputs as this build)' : ''}\n`,
        );
    } catch (err) {
      if (err instanceof Interrupted || c.signal?.aborted) return interrupted(c);
      if (err instanceof ApiError && err.code === 'template_exists') {
        code = Math.max(code, await existing(c, id, err));
        continue;
      }
      // A refusal of one spec does not stop the others; a lost login or control plane does.
      const f = failed(c, err);
      if (f !== SBX_EXIT.failed) return f;
      code = SBX_EXIT.failed;
    }
  }
  return code;
}

/**
 * A `409 template_exists`: the id is another subject's, or one the deployment declared (a create on
 * the caller's own id is a new build of it, never a 409). The template is read to say whose; if it
 * reads as the caller's own, the server's refusal is printed as sent.
 */
async function existing(c: SbxCtx, id: string, err: ApiError): Promise<number> {
  let t: SbxTemplateFull;
  try {
    t = await c.api.getTemplate(id);
  } catch {
    c.io.err(`sbx: ${refusalText(err)}`);
    return SBX_EXIT.failed;
  }
  c.io.err(
    t.owner === null
      ? `sbx: ${sanitizeRemote(id)} is a template the deployment declared: pick another id, or ask an admin to add the build`
      : t.owner !== c.rt.auth?.subject
        ? `sbx: ${sanitizeRemote(id)} belongs to ${sanitizeRemote(t.owner)}: pick another id`
        : `sbx: ${refusalText(err)}`,
  );
  return SBX_EXIT.failed;
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
  // Each Exec's lease events are said as they come (plan-4 M2).
  const exec = noticingExec(c, sandbox.id, x.exec);
  try {
    const timeoutS = x.lifetimeS - TOKEN_MARGIN_S > 0 ? x.lifetimeS - TOKEN_MARGIN_S : undefined;
    const r = await exec(seed, {
      ...(timeoutS !== undefined ? { timeoutS } : {}),
      signal: c.signal,
    });
    if (r.exitCode !== 0)
      return `the seed exited ${r.exitCode}: ${sanitizeRemote(r.stderr.toString().trim().slice(-400)) || 'no stderr'}`;
    const w = (await exec(WORKSPACE_CHECK, { timeoutS: 120, signal: c.signal })).stdout.toString();
    const git = !/^nogit$/m.test(w);
    const dirty = Number(/^dirty=(\d+)$/m.exec(w)?.[1] ?? '0');
    const head = /^head=([0-9a-f]{40,64})$/m.exec(w)?.[1] ?? null;
    if (git && dirty > 0)
      return `after the seed, /workspace has ${dirty} changed or untracked paths: not a clean tree`;
    // The seed's clean tree is the template's: the baseline `pull` and `rm` measure changes from.
    if (git && head !== null) await baselineAtHead(exec, WORKSPACE, { signal: c.signal });
    return { seed, exitCode: 0, clean: git ? dirty === 0 : null, head };
  } finally {
    x.close();
  }
}

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

/**
 * `templates retire ID [--build B] [--reason T] [--wait [--timeout S]]` (§5.1): retire the template
 * (every build of it) or build B, and print each build retired. With --wait, then read each build
 * until it is `retired`, its worker no longer runs (`capacity` null: the host stopped it, after
 * the wanted state's `stop`) and no host holds it any more (`heldBy` empty: each holding host has
 * removed its worker and snapshot, §6.1 step 7), saying so, once per change, while it waits;
 * `running` null, presence unreadable, is waited out too, never taken as stopped. Only a host agent
 * that holds the build stops and removes its worker (the wanted state lists the builds a host
 * holds), so a build no host holds has nothing to wait for: `heldBy` null (no host agents; or
 * absent, from an older control plane), or empty from the first read (no host holds it, such as an
 * imported template whose worker an operator runs). Then a worker that still runs is said to be not
 * host-managed, to be stopped where it runs. A wait past --timeout (default RETIRE_TIMEOUT_S) exits
 * 5. Nor does a `shared` build (its snapshot or worker serves a build that is not retired): its
 * worker is kept running for that build and never removed, and that is said at once.
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
      let wasHeld = false;
      for (;;) {
        let b: SbxBuild | undefined;
        try {
          b = await c.api.getTemplateBuild(r.templateId, build);
        } catch (err) {
          if (!transient(err)) throw err;
        }
        const held = b?.heldBy ?? [];
        if (held.length > 0) wasHeld = true;
        // Its worker serves a build that is not retired too: kept running for it, never stopped.
        if (b && b.status === 'retired' && b.shared === true) {
          c.io.err(
            `${sanitizeRemote(r.templateId)} ${sanitizeRemote(build)}: retired; its worker also ` +
              'serves a build that is not retired, so it keeps running for that build',
          );
          break;
        }
        // No host holds it (heldBy null or absent: no host agents; empty from the first read: none
        // holds this build): no host agent will stop or remove its worker, so it is done at once.
        if (b && b.status === 'retired' && (b.heldBy == null || (held.length === 0 && !wasHeld))) {
          c.io.err(
            `${sanitizeRemote(r.templateId)} ${sanitizeRemote(build)}: retired` +
              (b.capacity === null
                ? ', its worker stopped'
                : '; no host agent holds it, so its worker is not host-managed: stop it where it runs'),
          );
          break;
        }
        // Held by a host when the wait began: done once its worker stopped and every host removed it.
        if (b && b.status === 'retired' && b.capacity === null && held.length === 0) {
          c.io.err(
            `${sanitizeRemote(r.templateId)} ${sanitizeRemote(build)}: retired, ` +
              'its worker stopped and removed from every host',
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
                : b.capacity === null
                  ? `retired, its worker stopped; still held by ${held.map(sanitizeRemote).join(', ')}`
                  : `retired, its worker still runs${typeof inUse === 'number' ? ` (${inUse} in use)` : ''}`;
          if (why !== said)
            c.io.err(`${sanitizeRemote(r.templateId)} ${sanitizeRemote(build)}: ${why}`);
          said = why;
        }
        const left = end - c.rt.now();
        if (left <= 0)
          return timedOut(
            c,
            `${r.templateId} ${build} to stop its worker and be removed from every host`,
            timeoutS,
          );
        await c.rt.sleep(Math.min(POLL_MS, left), c.signal);
        if (c.signal?.aborted) return SBX_EXIT.failed;
      }
    }
    return SBX_EXIT.ok;
  } catch (err) {
    return failed(c, err);
  }
}
