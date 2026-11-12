import { CpError } from './errors.js';
import { asRecord, seconds } from './handler-util.js';
import type { CpDeps, Handler, RequestCtx } from './handlers.js';
import { recordDigest } from './provenance.js';
import { LOG_MAX, type TemplateBuild, type TemplateDoc } from './template-catalog.js';
import { liveLeases, place, type HostView } from './activation.js';
import { isLive, type SandboxRecord } from './sandbox-store.js';
import {
  EGRESS_DROP_WINDOW_S,
  EGRESS_GRACE_S,
  EGRESS_POST_MAX,
  egressLine,
  parseEgressEvent,
  type EgressGroup,
} from './egress-log.js';

/**
 * The template host agent's routes (template lifecycle spec §6.1): a KVM host's `sbx-host-agent`
 * polls these with its own bearer (`auth: 'host'`, SH_HOST_TOKEN_<ID>); the host named in the path
 * is the one whose token was presented, so a host reports only for itself.
 *
 *   POST /v1/hosts/{host}/inventory          what it holds (by manifest hash) and its limits
 *   POST /v1/hosts/{host}/builds/claim       up to N queued builds, oldest first, subjects in turn
 *   GET  /v1/hosts/{host}/blobs/{digest}     a gate record a claimed build cites, byte for byte
 *   POST /v1/hosts/{host}/builds/{build}/log      log entries for a build it claimed
 *   POST /v1/hosts/{host}/builds/{build}/report   a step: building, probing, built (with T and S), failed
 *
 * The control plane never trusts a report it cannot tie to its chain: a report must answer a build
 * this host claimed. On `built` it checks the build record against the create's request and the
 * policy (§8.2) and registers or rejects the build, automatically, with a `check` record.
 *
 *   GET  /v1/hosts/{host}/wanted             the builds this host should run (leased and placed on
 *                                            it), and those it holds that it should stop (no lease
 *                                            left, no live sandbox)
 *   POST /v1/hosts/{host}/workers/report     {buildId, event: attached | refused | detached, reason?}
 *   POST /v1/hosts/{host}/egress             {events, cursor}: the egress proxy's audit events, as it
 *                                            wrote them, into each sandbox's egress log
 *
 * Readiness itself is never taken from a report: `active` is the relay's attached record (§3.3).
 * The worker reports are provenance: who ran what, where, when.
 */

const MANIFEST_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const CLAIM_MAX = 4;
/** The host agent's journal cursor, opaque here: printable ASCII, bounded. */
const CURSOR_RE = /^[\x21-\x7e]{1,512}$/;

/**
 * The spec a host agent hands template-build.sh for a claimed build. The API takes the guest's size as
 * `guest_mb` or `guest_ram_mb` (policy M7.guest reads either), but template-build.sh reads only
 * `guest_ram_mb`, so a create that named `guest_mb` passed the policy and then failed the build's own
 * spec check. The job always names `guest_ram_mb`, with the value the policy checked
 * (`guest_mb ?? guest_ram_mb`, as M7 and the build's S.guest_ram_mb check read it); `guest_mb` is
 * dropped from it. The job's `id` and `image` are always the template's and the
 * create's, whatever the spec carries.
 */
export function buildJobSpec(
  id: string,
  image: string,
  spec: Record<string, unknown>,
): Record<string, unknown> {
  const { guest_mb, ...rest } = spec;
  const guest = guest_mb ?? rest.guest_ram_mb;
  // The template's own id and the create's image come last, so a spec key of the same name (which
  // the create does not refuse) can't rename the build or swap its image in the job.
  return { ...rest, ...(guest !== undefined ? { guest_ram_mb: guest } : {}), id, image };
}

/** The workers of the builds a host holds (its last inventory): whose sandboxes it may report. */
async function hostWorkers(deps: CpDeps, host: string): Promise<Set<string>> {
  const holds = deps.hosts?.get(host)?.holds ?? {};
  const out = new Set<string>();
  for (const d of (await deps.templates?.list()) ?? [])
    for (const b of d.builds) if (b.worker && holds[b.buildId] !== undefined) out.add(b.worker);
  return out;
}

const endOf = (r: SandboxRecord) => r.deletedAt ?? r.expiresAt;

/**
 * The sandboxes whose egress events this host may ship: every sandbox on a worker of
 * a build this host holds (hostSandboxes), live or ended less than EGRESS_GRACE_S ago
 * (egressAccepts). hostEgress accepts events for exactly these, and hostWanted hands their workspace
 * keys to the agent (`egressSids`), which sends nothing else, so the events of the proxy's other
 * clients (a Moca P6 session) never leave the host.
 */
async function hostSandboxes(deps: CpDeps, host: string, nowS: number): Promise<SandboxRecord[]> {
  if (!deps.sandboxes || !deps.egress) return [];
  const workers = await hostWorkers(deps, host);
  if (!workers.size) return [];
  return (await deps.sandboxes.listAll(nowS)).filter((r) => workers.has(r.worker));
}

/** Of a host's sandboxes, the ones whose events are taken now: live, or ended within the grace. */
const egressAccepts = (rs: SandboxRecord[], nowS: number): SandboxRecord[] =>
  rs.filter((r) => nowS < endOf(r) + EGRESS_GRACE_S);

/** An event's time in epoch seconds; `fallback` when it does not parse. */
function eventSeconds(e: Record<string, unknown>, fallback: number): number {
  const t = typeof e.time === 'string' ? Date.parse(e.time) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : fallback;
}

export interface HostState {
  /** Epoch seconds of the host's last inventory. */
  at: number;
  /** manifest hash -> template id, what the host holds. */
  holds: Record<string, string>;
  limits: {
    activeLimit: number;
    idleLimitSeconds: number;
    buildConcurrency: number;
    diskFreeGb: number;
    diskFloorGb: number;
  };
}

/** In-memory host state; the inventory is re-sent on every poll, so a restart loses nothing durable. */
export class HostRegistry {
  private readonly hosts = new Map<string, HostState>();
  set(id: string, st: HostState): void {
    this.hosts.set(id, st);
  }
  get(id: string): HostState | undefined {
    return this.hosts.get(id);
  }
  all(): [string, HostState][] {
    return [...this.hosts.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }
}

/** The hosts as their agents last reported (§6.1), as placement reads them. */
export function hostViewsOf(deps: CpDeps): HostView[] {
  return (deps.hosts?.all() ?? []).map(([id, h]) => ({
    id,
    holds: h.holds,
    activeLimit: h.limits.activeLimit,
  }));
}

function catalogOf(deps: CpDeps) {
  const cat = deps.templates;
  if (!cat?.update || !deps.provenance || !deps.policy) {
    throw new CpError(
      'invalid_request',
      'this deployment does not store templates (SH_PROVENANCE_DIR is unset)',
    );
  }
  return { cat: cat as Required<typeof cat>, prov: deps.provenance, policy: deps.policy };
}

const hostOf = (ctx: RequestCtx): string => {
  if (!ctx.host) throw new CpError('unauthorized', 'host authentication failed');
  return ctx.host;
};

const nonNeg = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/** Finds the build a host refers to by handle or build id, in a template it claimed it for. */
async function claimedBuild(
  deps: CpDeps,
  host: string,
  handle: string,
): Promise<{ doc: TemplateDoc; build: TemplateBuild }> {
  const { cat } = catalogOf(deps);
  for (const doc of await cat.list()) {
    const build = doc.builds.find((b) => b.handle === handle || b.buildId === handle);
    if (build) {
      if (build.claim?.host !== host)
        throw new CpError('not_found', 'no such build claimed by this host');
      return { doc, build };
    }
  }
  throw new CpError('not_found', 'no such build claimed by this host');
}

/** What a built report's records must say about the request (§8.2): the registration check. */
function registrationResults(
  build: TemplateBuild,
  t: Record<string, unknown>,
  sManifest: Record<string, unknown>,
) {
  const req = build.request!;
  const spec = req.spec;
  const out: { rule: string; passed: boolean; message?: string }[] = [];
  const rule = (id: string, ok: boolean, message: string) =>
    out.push(ok ? { rule: id, passed: true } : { rule: id, passed: false, message });
  rule(
    'T.schema',
    t.schema === 'moca-sbx-template/1',
    'the template record is not moca-sbx-template/1',
  );
  rule('T.image', t.image === req.image, 'the template record names another image than the create');
  const hash = t.manifest_hash;
  rule(
    'T.manifest_hash',
    typeof hash === 'string' && MANIFEST_HASH_RE.test(hash),
    'the template record has no manifest_hash',
  );
  rule(
    'S.hash',
    sManifest.hash === hash,
    "the manifest's hash is not the template record's manifest_hash",
  );
  rule(
    'S.hash_version',
    sManifest.hash_version === 2,
    'the manifest is not hash version 2 (PV2-PV3): rebuild with the current build-snapshot.sh',
  );
  const digest = req.image.slice(req.image.indexOf('@') + 1);
  rule(
    'S.source_image_digest',
    sManifest.source_image_digest === digest,
    "the snapshot's rootfs is not from the create's image (R)",
  );
  const guest = spec.guest_mb ?? spec.guest_ram_mb;
  rule(
    'S.guest_ram_mb',
    sManifest.guest_ram_mb === guest && t.guest_ram_mb === guest,
    "the guest size is not the spec's",
  );
  rule('S.vcpus', sManifest.vcpus === spec.vcpus, "the vCPU count is not the spec's");
  rule(
    'T.probe',
    t.probe_status === undefined || t.probe_status === spec.probe_status,
    'the probe status differs from the spec',
  );
  if (req.gateRecordSha256) {
    const g = (t.gate_record as Record<string, unknown> | undefined)?.sha256;
    rule(
      'T.gate_record',
      g === req.gateRecordSha256,
      'the template record cites another gate record than the create (X10)',
    );
  }
  if (spec.skip_git_identity_check === true) {
    rule(
      'T.X12',
      t.skip_git_identity_check === true,
      'the template record does not carry skip_git_identity_check (X12)',
    );
  }
  return out;
}

export const HOST_HANDLERS: Record<string, Handler> = {
  /**
   * The egress proxy's audit events from this host's journal. An event is stored in
   * a sandbox's log only when its `sid` is the workspace key (`wsk`) of a sandbox on a worker of a
   * build this host holds, and the sandbox has not ended more than EGRESS_GRACE_S ago; every other
   * event is refused and counted. An event naming such a sandbox that is not exactly a proxy Event
   * is not stored, and counted as dropped in that sandbox's log, as is each `oversized` sid (an event
   * the agent kept back for its size). An `audit_dropped` event (no VM)
   * is charged to every sandbox on this host's workers live within EGRESS_DROP_WINDOW_S before it
   * (egress-log.ts). Idempotent by (host, cursor): the agent's retry of a post repeats its cursor.
   */
  hostEgress: async (ctx, deps) => {
    const host = hostOf(ctx);
    const b = asRecord(ctx.body);
    if (typeof b.cursor !== 'string' || !CURSOR_RE.test(b.cursor))
      throw new CpError('invalid_request', 'cursor must be the journal cursor, printable ASCII');
    const oversized = b.oversized ?? [];
    if (
      !Array.isArray(b.events) ||
      !Array.isArray(oversized) ||
      b.events.length + oversized.length > EGRESS_POST_MAX
    )
      throw new CpError(
        'invalid_request',
        `events and oversized must be arrays of at most ${EGRESS_POST_MAX} in all`,
      );
    const nowS = seconds(deps);
    const retentionS = deps.config.sandbox?.retentionS ?? 0;
    // Every sandbox of the host's workers for the drop rule; only egressAccepts' for events.
    const mine = await hostSandboxes(deps, host, nowS);
    const byWsk = new Map(egressAccepts(mine, nowS).map((r) => [r.wsk, r]));
    const groups = new Map<string, EgressGroup>();
    const group = (r: SandboxRecord) => {
      let g = groups.get(r.id);
      if (!g) {
        g = {
          sandboxId: r.id,
          lines: [],
          proxyDropped: 0,
          invalid: 0,
          expireAtS: endOf(r) + retentionS,
        };
        groups.set(r.id, g);
      }
      return g;
    };
    let refused = 0;
    let dropped = 0;
    for (const raw of b.events) {
      const o = asRecord(raw);
      if (raw === o && o.decision === 'audit_dropped' && !o.sid) {
        const n = nonNeg(o.dropped) ?? 0;
        const t = eventSeconds(o, nowS);
        dropped += n;
        for (const r of mine)
          if (r.createdAt <= t && endOf(r) >= t - EGRESS_DROP_WINDOW_S) group(r).proxyDropped += n;
        continue;
      }
      const r = typeof o.sid === 'string' ? byWsk.get(o.sid) : undefined;
      if (!r) {
        refused += 1;
        continue;
      }
      const e = parseEgressEvent(raw);
      const line = e && egressLine(e);
      if (line) group(r).lines.push(line);
      else group(r).invalid += 1;
    }
    // Events the agent did not send because they were too long (over 8 KiB): only their sid comes,
    // and each is counted as dropped in its sandbox's log, as an event that is not an Event.
    for (const sid of oversized) {
      const r = typeof sid === 'string' ? byWsk.get(sid) : undefined;
      if (!r) refused += 1;
      else group(r).invalid += 1;
    }
    if (!deps.egress) {
      return {
        status: 200,
        body: {
          accepted: 0,
          refused,
          capped: 0,
          overBudget: 0,
          invalid: 0,
          dropped,
          cursor: b.cursor,
        },
      };
    }
    const answer = await deps.egress.append(host, b.cursor, [...groups.values()], refused, dropped);
    return { status: 200, body: answer };
  },

  /**
   * The wanted state (§6.3): `run`, the registered builds this host holds that are leased and
   * placed on it (the same placement activate judges by), and `stop`, the ones it holds with no
   * live lease. A worker is never stopped under a live sandbox: it drains first, so a build with
   * one is in neither list. `egressSids`: the workspace keys of the sandboxes whose egress events
   * the agent ships (hostSandboxes), and no others.
   */
  hostWanted: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat } = catalogOf(deps);
    const nowS = seconds(deps);
    const docs = await cat.list();
    const p = place(docs, hostViewsOf(deps), nowS);
    const mine = deps.hosts?.get(host);
    const busy = new Set<string>();
    if (deps.sandboxes) {
      for (const r of await deps.sandboxes.listAll(nowS)) if (isLive(r, nowS)) busy.add(r.worker);
    }
    const run: Record<string, unknown>[] = [];
    const stop: Record<string, unknown>[] = [];
    for (const d of docs) {
      for (const b of d.builds) {
        if (b.status !== 'registered' || !mine || mine.holds[b.buildId] === undefined) continue;
        const entry = { template: d.id, buildId: b.buildId, worker: b.worker };
        if (p.placed.get(b.buildId) === host) run.push(entry);
        else if (liveLeases(b, nowS).length === 0 && !busy.has(b.worker)) stop.push(entry);
      }
    }
    const egressSids = egressAccepts(await hostSandboxes(deps, host, nowS), nowS)
      .map((r) => r.wsk)
      .sort();
    return { status: 200, body: { run, stop, egressSids } };
  },

  /**
   * A worker started (`attached`: its unit is running), not started (`refused`, with why: not
   * installed, or the start failed) or stopped (`detached`), for a registered build this host
   * holds: an `activate` or `deactivate` record by the host. Readiness still comes from the relay.
   */
  hostWorkerReport: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat, prov } = catalogOf(deps);
    const b = asRecord(ctx.body);
    const event = b.event;
    if (event !== 'attached' && event !== 'refused' && event !== 'detached') {
      throw new CpError('invalid_request', 'event must be attached, refused or detached');
    }
    const buildId = typeof b.buildId === 'string' ? b.buildId : '';
    const doc = (await cat.list()).find((d) =>
      d.builds.some((x) => x.buildId === buildId && x.status === 'registered'),
    );
    if (!doc || deps.hosts?.get(host)?.holds[buildId] === undefined) {
      throw new CpError('not_found', 'no registered build this host holds');
    }
    const reason = typeof b.reason === 'string' ? b.reason.slice(0, 1024) : undefined;
    await prov.append({
      stream: `template/${doc.id}`,
      kind: event === 'detached' ? 'deactivate' : 'activate',
      subject: `host:${host}`,
      body: { buildId, event, ...(reason ? { reason } : {}) },
    });
    return { status: 200, body: { recorded: event } };
  },

  hostInventory: async (ctx, deps) => {
    const host = hostOf(ctx);
    const b = asRecord(ctx.body);
    const holds: Record<string, string> = {};
    const inv = Array.isArray(b.holds) ? b.holds : [];
    for (const h of inv) {
      const r = asRecord(h);
      if (
        typeof r.manifestHash === 'string' &&
        MANIFEST_HASH_RE.test(r.manifestHash) &&
        typeof r.template === 'string'
      ) {
        holds[r.manifestHash] = r.template;
      }
    }
    const l = asRecord(b.limits);
    const limits = {
      activeLimit: nonNeg(l.activeLimit) ?? 0,
      idleLimitSeconds: nonNeg(l.idleLimitSeconds) ?? 0,
      buildConcurrency: nonNeg(l.buildConcurrency) ?? 1,
      diskFreeGb: nonNeg(l.diskFreeGb) ?? 0,
      diskFloorGb: nonNeg(l.diskFloorGb) ?? 0,
    };
    deps.hosts?.set(host, { at: seconds(deps), holds, limits });
    return { status: 200, body: { host, holds: Object.keys(holds).length } };
  },

  hostClaimBuilds: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat } = catalogOf(deps);
    const b = asRecord(ctx.body);
    const want = Math.min(nonNeg(b.max) ?? 1, CLAIM_MAX);
    const now = seconds(deps);
    // Oldest first, one subject's at a time in turn (§6.1 step 2), so one batch holds no host.
    const queued = (await cat.list())
      .flatMap((d) =>
        d.builds.filter((x) => x.status === 'queued' && x.request).map((x) => ({ d, x })),
      )
      .sort(
        (p, q) =>
          (p.x.queuedAtMs ?? p.x.createdAt * 1000) - (q.x.queuedAtMs ?? q.x.createdAt * 1000) ||
          (p.x.handle! < q.x.handle! ? -1 : 1),
      );
    const order: typeof queued = [];
    const bySubject = new Map<string, typeof queued>();
    for (const e of queued) {
      const k = e.d.owner ?? '';
      if (!bySubject.has(k)) bySubject.set(k, []);
      bySubject.get(k)!.push(e);
    }
    while (order.length < queued.length) {
      for (const list of bySubject.values()) if (list.length) order.push(list.shift()!);
    }
    const claimed: Record<string, unknown>[] = [];
    for (const { d, x } of order) {
      if (claimed.length >= want) break;
      let got = false;
      await cat.update(d.id, async (cur) => {
        const doc = cur!;
        const build = doc.builds.find((y) => y.handle === x.handle);
        if (!build || build.status !== 'queued') return doc; // another host took it
        got = true;
        return {
          ...doc,
          builds: doc.builds.map((y) =>
            y === build ? { ...y, status: 'building' as const, claim: { host, at: now } } : y,
          ),
        };
      });
      if (!got) continue;
      claimed.push({
        template: d.id,
        build: x.handle,
        image: x.request!.image,
        spec: buildJobSpec(d.id, x.request!.image, x.request!.spec),
        ...(x.request!.gateRecordSha256
          ? { gateRecord: `/v1/hosts/${host}/blobs/${x.request!.gateRecordSha256}` }
          : {}),
      });
    }
    return { status: 200, body: { builds: claimed } };
  },

  hostBlob: async (ctx, deps) => {
    hostOf(ctx);
    const { prov } = catalogOf(deps);
    const blob = await prov.getBlob(ctx.params.digest ?? '').catch(() => null);
    if (!blob) throw new CpError('not_found', 'no such document');
    return { status: 200, body: { sha256: ctx.params.digest, base64: blob.toString('base64') } };
  },

  hostBuildLog: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat } = catalogOf(deps);
    const { doc, build } = await claimedBuild(deps, host, ctx.params.build ?? '');
    const b = asRecord(ctx.body);
    const now = seconds(deps);
    const entries = (Array.isArray(b.entries) ? b.entries : []).slice(0, 200).flatMap((e) => {
      const r = asRecord(e);
      const level = r.level === 'warn' || r.level === 'error' ? r.level : 'info';
      return typeof r.message === 'string'
        ? [
            {
              at: now,
              level: level as 'info' | 'warn' | 'error',
              step: typeof r.step === 'string' ? r.step.slice(0, 64) : '',
              message: r.message.slice(0, 4096),
            },
          ]
        : [];
    });
    await cat.update(doc.id, async (cur) => ({
      ...cur!,
      builds: cur!.builds.map((y) =>
        y.handle === build.handle
          ? { ...y, log: [...(y.log ?? []), ...entries].slice(-LOG_MAX) }
          : y,
      ),
    }));
    return { status: 200, body: { appended: entries.length } };
  },

  hostBuildReport: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat, prov, policy } = catalogOf(deps);
    const { doc, build } = await claimedBuild(deps, host, ctx.params.build ?? '');
    const b = asRecord(ctx.body);
    const event = b.event;
    const stream = `template/${doc.id}`;
    const terminal = new Set(['built', 'registered', 'rejected', 'failed', 'retired']);
    if (terminal.has(build.status) && build.status !== 'built') {
      throw new CpError(
        'invalid_request',
        `the build is ${build.status}; it takes no more reports`,
      );
    }
    const setBuild = (patch: Partial<TemplateBuild>) =>
      cat.update(doc.id, async (cur) => ({
        ...cur!,
        builds: cur!.builds.map((y) => (y.handle === build.handle ? { ...y, ...patch } : y)),
      }));
    if (event === 'building' || event === 'probing') {
      await setBuild({ status: event });
      return { status: 200, body: { status: event } };
    }
    if (event === 'failed') {
      const step = typeof b.step === 'string' ? b.step.slice(0, 64) : 'unknown';
      const message = typeof b.message === 'string' ? b.message.slice(0, 4096) : 'the build failed';
      await prov.append({
        stream,
        kind: 'build',
        subject: `host:${host}`,
        body: { handle: build.handle!, outcome: 'failed', step, message },
      });
      await setBuild({ status: 'failed', reason: { message, step } });
      return { status: 200, body: { status: 'failed' } };
    }
    if (event !== 'built')
      throw new CpError('invalid_request', 'event must be building, probing, built or failed');
    // The build record (T) and the manifest (S), as the host's files: kept in the store byte for
    // byte, so an offline check can read exactly what was reported.
    if (typeof b.templateRecord !== 'string' || typeof b.manifest !== 'string') {
      throw new CpError(
        'invalid_request',
        'a built report carries templateRecord and manifest, each its file as a string',
      );
    }
    let t: Record<string, unknown>;
    let sm: Record<string, unknown>;
    try {
      t = asRecord(JSON.parse(b.templateRecord));
      sm = asRecord(JSON.parse(b.manifest));
    } catch {
      throw new CpError('invalid_request', 'templateRecord and manifest must be JSON');
    }
    const tSha = await prov.putBlob(Buffer.from(b.templateRecord, 'utf8'));
    const sSha = await prov.putBlob(Buffer.from(b.manifest, 'utf8'));
    const buildRec = await prov.append({
      stream,
      kind: 'build',
      subject: `host:${host}`,
      body: {
        handle: build.handle!,
        outcome: 'built',
        manifest_hash: String(t.manifest_hash ?? ''),
        template_record_sha256: tSha,
        manifest_sha256: sSha,
        worker: String(t.worker ?? ''),
        snapshot: String(t.snapshot ?? ''),
      },
    });
    // Registration (§8.2): automatic, by policy, never a person.
    const results = registrationResults(build, t, sm);
    const failed = results.find((r) => !r.passed);
    const { record: policyRecord } = await policy.current();
    const outcome = failed ? 'rejected' : 'registered';
    await prov.append({
      stream,
      kind: 'check',
      subject: 'policy',
      body: {
        policy: policyRecord,
        profile: build.profile,
        at: 'registration',
        build: recordDigest(buildRec.record),
        outcome,
        results: results as unknown as Record<string, unknown>[],
      },
    });
    const manifestHash = String(t.manifest_hash);
    await cat.update(doc.id, async (cur) => {
      const c = cur!;
      const builds = c.builds.map((y) =>
        y.handle !== build.handle
          ? y
          : failed
            ? {
                ...y,
                status: 'rejected' as const,
                reason: { message: failed.message ?? failed.rule, rule: failed.rule },
              }
            : {
                ...y,
                status: 'registered' as const,
                buildId: manifestHash,
                worker: String(t.worker ?? ''),
              },
      );
      // A first registered build of a template takes `default` (§3.2); later ones are tagged by the owner.
      const tags =
        !failed && c.tags.default === undefined ? { ...c.tags, default: manifestHash } : c.tags;
      return { ...c, builds, tags };
    });
    return {
      status: 200,
      body: { status: outcome, ...(failed ? { rule: failed.rule } : { buildId: manifestHash }) },
    };
  },
};
