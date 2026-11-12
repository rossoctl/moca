import { readFileSync } from 'node:fs';
import { TOKEN_MARGIN_S, WORKSPACE } from '@moca/sandbox-client';
import { ApiError } from '../api/errors.js';
import { describeError } from '../core/messages.js';
import { sanitizeRemote } from '../core/sanitize.js';
import type {
  SbxBuild,
  SbxPolicyView,
  SbxQueued,
  SbxTemplateCreate,
  SbxTemplateFull,
} from './api.js';
import { failed, refusalText, SBX_EXIT, type SbxCtx } from './commands.js';
import { dryRun } from './dry-run.js';
import { openExec, type ExecFactory } from './exec.js';
import { baselineAtHead } from './push.js';

/**
 * The template commands of mocactl (template lifecycle spec §4, §8): the reads a client makes
 * before a create (quota, policy), one template and its builds or one build, create and follow a
 * build, cancel it, and `create --seed`, which runs the served build's own seed. Every command has
 * `--json` (the API's answer, never a token); a wait that runs out of time exits 5.
 */

/** `templates follow`'s default bound, in seconds; also the bound of a create's wait for a queue slot. */
export const FOLLOW_TIMEOUT_S = 3600;
/** Between two polls of a build, in milliseconds. */
export const POLL_MS = 5000;
/** A wait for a queue slot (`429 buildsQueued`) when the answer names no Retry-After. */
const QUEUE_SLOT_WAIT_MS = 30_000;

/** The statuses a build ends in: `templates follow` stops there. A cancelled build is `failed`. */
const BUILD_ENDS = new Set(['registered', 'failed', 'rejected', 'retired']);

const clock = (c: SbxCtx) => ({ sleep: c.sleep ?? c.rt.sleep, now: c.now ?? c.rt.now });

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

/** A build's readiness, with its capacity when it is active: `active (running 3, in use 1)`. */
function readinessText(b: Pick<SbxBuild, 'readiness' | 'capacity'>): string {
  if (b.readiness === null) return '';
  const c = b.capacity;
  const cap = c ? ` (running ${c.running}${c.inUse !== null ? `, in use ${c.inUse}` : ''})` : '';
  return `${sanitizeRemote(b.readiness)}${cap}`;
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
        `${t.readiness !== null ? `  ${sanitizeRemote(t.readiness)}` : ''}\n`,
    );
    for (const b of t.builds) c.io.out(`  ${buildLine(b)}\n`);
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
    if (c.signal?.aborted) throw new Error('interrupted');
  }
}

const timedOut = (c: SbxCtx, what: string, s: number) => {
  c.io.err(`sbx: timed out after ${s} s waiting for ${what} (exit ${SBX_EXIT.timedOut})`);
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

/** `templates follow ID [--build B] [--timeout S]`: until the build ends; exit 0 only on registered. */
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

/** What a create reads from its files: one spec (or a gate record's `template` block). */
export interface CreateInput {
  file: string;
  body: SbxTemplateCreate & { id: string };
}

/**
 * Reads a create's inputs: F is a spec, or a gate record whose `template` block is the spec. The id
 * and the image default to the spec's own; given, they must equal them (M7.spec_id, M7.spec_image).
 * The gate record is read as text and must round-trip byte for byte, since its sha256 is what the
 * policy trusts. Returns the bodies, or the line saying why not.
 */
export function readCreateInputs(
  files: string[],
  o: { id?: string; image?: string; profile?: string; visibility?: string; gateRecord?: string },
): CreateInput[] | string {
  let gateRecord: string | undefined;
  if (o.gateRecord !== undefined) {
    let raw: Buffer;
    try {
      raw = readFileSync(o.gateRecord);
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
    for (const n of r.notes) c.io.err(`sbx: ${sanitizeRemote(body.id)}: ${n}`);
    if (r.failed) {
      c.io.err(
        `sbx: ${sanitizeRemote(body.id)} (${sanitizeRemote(file)}): would be refused by policy rule ${r.failed.rule}: ${r.failed.message}`,
      );
      code = SBX_EXIT.failed;
    }
  }
  return code;
}

/**
 * One create, waiting out `429 quota_exceeded {quota: buildsQueued}` for a queue slot until `end`.
 * `waiting` is how many creates, this one included, wait behind the quota. Any other refusal is
 * thrown. Returns the answer, or 'timeout'.
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
      if (c.signal?.aborted) throw err;
    }
  }
}

/**
 * `templates create --spec F …` and `templates build ID --spec F`: each spec posted once, in
 * order, its answer printed (one JSON object per line with --json). A `409 template_exists` says
 * whose the id is: the caller's own is followed instead of posted again, another's is a refusal.
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

/** A `409 template_exists`: the caller's own template is followed to its newest build; another's is named. */
async function existing(c: SbxCtx, id: string, err: ApiError): Promise<number> {
  let t: SbxTemplateFull;
  try {
    t = await c.api.getTemplate(id);
  } catch {
    c.io.err(`sbx: ${refusalText(err)}`);
    return SBX_EXIT.failed;
  }
  const me = c.rt.auth?.subject;
  if (t.owner !== null && t.owner === me) {
    const b = t.builds[0];
    if (!b) {
      c.io.err(`sbx: ${sanitizeRemote(id)} is yours but has no build`);
      return SBX_EXIT.failed;
    }
    const ref = buildRef(b);
    c.io.err(
      `${sanitizeRemote(id)} is already yours: following its newest build, ${sanitizeRemote(ref)}`,
    );
    const q: SbxQueued = {
      templateId: t.id,
      buildId: b.status === 'registered' ? b.buildId : null,
      build: `/v1/templates/${t.id}/builds/${ref}`,
      status: b.status,
      reused: true,
    };
    if (c.json) c.io.out(JSON.stringify(q) + '\n');
    else
      c.io.out(
        `${sanitizeRemote(t.id)} ${sanitizeRemote(ref)} ${sanitizeRemote(b.status)} (yours already)\n`,
      );
    return SBX_EXIT.ok;
  }
  c.io.err(
    t.owner === null
      ? `sbx: ${sanitizeRemote(id)} is a template the deployment declared: pick another id, or ask an admin to add the build`
      : `sbx: ${sanitizeRemote(id)} belongs to ${sanitizeRemote(t.owner)}: pick another id`,
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
