import { CpError } from './errors.js';
import { asRecord, seconds } from './handler-util.js';
import type { CpDeps, Handler, RequestCtx } from './handlers.js';
import { buildRecordOf, recordDigest } from './provenance.js';
import { LOG_MAX, type TemplateBuild, type TemplateDoc } from './template-catalog.js';
import { hostManaged, liveLeases, place, type HostView } from './activation.js';
import { isLive } from './sandbox-store.js';

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
 *                                            it), those it holds that it should stop (no lease
 *                                            left, no live sandbox), and the retired ones it should
 *                                            remove (worker and snapshot, no live sandbox)
 *   POST /v1/hosts/{host}/workers/report     {buildId, event: attached | refused | detached |
 *                                            removed, reason?}
 *
 * Readiness itself is never taken from a report: `active` is the relay's attached record (§3.3).
 * The worker reports are provenance: who ran what, where, when.
 */

const MANIFEST_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const CLAIM_MAX = 4;

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

export interface HostState {
  /** Epoch seconds of the host's last inventory. */
  at: number;
  /** manifest hash -> template id, what the host holds. */
  holds: Record<string, string>;
  /**
   * The held builds whose worker unit runs: as the last inventory said, then kept current by the
   * host's attached and detached reports, so placement counts what the host really runs.
   */
  running: string[];
  /**
   * buildId -> the last `refused` report (its reason) this host made for a build it is still asked
   * to run: a repeat is not recorded again (hostWorkerReport). Cleared once the build leaves the
   * host's `run`, or on any other report for it.
   */
  refused?: Record<string, string>;
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

/**
 * A host whose last inventory is older than this is left out of placement, of the hosts block and of
 * the default lease until it reports again: three of the build poll's two-minute intervals (the
 * --wanted-only timer re-sends it every 15 s). A host whose agent died or was removed then takes no
 * new placement and no activeLimit slot, and a deployment whose every host is silent reads
 * readiness from the workers' presence alone, as before any host reported.
 */
export const HOST_STALE_S = 360;

/** The hosts as their agents last reported (§6.1), as placement reads them: fresh ones only. */
export function hostViewsOf(deps: CpDeps): HostView[] {
  return freshHosts(deps).map(([id, h]) => ({
    id,
    holds: h.holds,
    activeLimit: h.limits.activeLimit,
    running: h.running,
  }));
}

/** The workers with a live sandbox: never stopped under one, so they drain and keep their slot. */
export async function busyWorkers(deps: CpDeps, nowS: number): Promise<Set<string>> {
  const busy = new Set<string>();
  if (deps.sandboxes) {
    for (const r of await deps.sandboxes.listAll(nowS)) if (isLive(r, nowS)) busy.add(r.worker);
  }
  return busy;
}

/** The hosts whose last inventory is at most HOST_STALE_S old, by id. */
export function freshHosts(deps: CpDeps): [string, HostState][] {
  const nowS = seconds(deps);
  return (deps.hosts?.all() ?? []).filter(([, h]) => nowS - h.at <= HOST_STALE_S);
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

/** The statuses a host may still report on: claimed, and not yet registered, rejected or failed. */
const REPORTABLE = new Set<TemplateBuild['status']>(['building', 'probing', 'built']);

/**
 * The build ids and workers of every build that is not retired, in every template. A retired build
 * that shares either with one (the same snapshot built again, a twin in another template, a worker
 * id reused) names a snapshot or worker still needed: it is never stopped or removed for the
 * retire, and its `removed` is refused.
 */
function liveSnapshots(docs: { builds: TemplateBuild[] }[]): (b: TemplateBuild) => boolean {
  const ids = new Set<string>();
  const workers = new Set<string>();
  for (const d of docs)
    for (const b of d.builds) {
      if (b.status === 'retired') continue;
      ids.add(b.buildId);
      if (b.worker) workers.add(b.worker);
    }
  return (b) => ids.has(b.buildId) || (b.worker !== '' && workers.has(b.worker));
}

/** Refuses a report on a build that is not this host's, or that takes no more reports. */
function reportable(y: TemplateBuild, host: string): void {
  if (y.claim?.host !== host) throw new CpError('not_found', 'no such build claimed by this host');
  if (!REPORTABLE.has(y.status))
    throw new CpError('invalid_request', `the build is ${y.status}; it takes no more reports`);
}

export const HOST_HANDLERS: Record<string, Handler> = {
  /**
   * The wanted state (§6.3): `run`, the registered builds this host holds that are leased and
   * placed on it (the same placement activate judges by), and `stop`, the ones it holds with no
   * live lease, or that it runs while placement keeps them on another host, and the retired ones it
   * holds (§5.1: no longer wanted, never run again). A worker is never stopped under a live
   * sandbox: it drains first, so a build with one is in no list. `remove` (§6.1 step 7): the
   * retired builds it holds with no live sandbox, listed in `stop` too, so the agent stops a
   * running worker before it uninstalls it and deletes the snapshot. A build imported from
   * SH_SANDBOX_TEMPLATES (not hostManaged) is in no list, retired or not: the deployment runs its
   * worker.
   */
  hostWanted: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat } = catalogOf(deps);
    const nowS = seconds(deps);
    const docs = await cat.list();
    const busy = await busyWorkers(deps, nowS);
    const p = place(docs, hostViewsOf(deps), nowS, busy);
    const mine = deps.hosts?.get(host);
    const run: Record<string, unknown>[] = [];
    const stop: Record<string, unknown>[] = [];
    const remove: Record<string, unknown>[] = [];
    const shared = liveSnapshots(docs);
    for (const d of docs) {
      for (const b of d.builds) {
        if (!mine || mine.holds[b.buildId] === undefined || !hostManaged(b)) continue;
        const entry = { template: d.id, buildId: b.buildId, worker: b.worker };
        // A retired build has no lease and is never placed: once its worker is idle it is stopped,
        // then removed from the host with its snapshot. Never one with a live sandbox.
        if (b.status === 'retired') {
          // Its snapshot or worker serves a build that is not retired: left alone (that build's
          // own entries decide whether its worker runs).
          if (shared(b)) continue;
          if (mine.refused) delete mine.refused[b.buildId];
          if (b.worker && !busy.has(b.worker)) {
            stop.push(entry);
            remove.push(entry);
          }
          continue;
        }
        if (b.status !== 'registered') continue;
        if (p.placed.get(b.buildId) === host) {
          run.push(entry);
          continue;
        }
        if (mine.refused) delete mine.refused[b.buildId];
        // Stopped when no lease is left, or when it runs here while placement keeps it on another
        // host (one worker id on two hosts): this host's copy stops. Never under a live sandbox.
        const unleased = liveLeases(b, nowS).length === 0;
        if (!busy.has(b.worker) && (unleased || mine.running.includes(b.buildId))) stop.push(entry);
      }
    }
    return { status: 200, body: { run, stop, remove } };
  },

  /**
   * A worker started (`attached`: its unit is running), not started (`refused`, with why: not
   * installed, or the start failed) or stopped (`detached`), for a registered build this host
   * holds (`detached` also for a retired one, whose worker `stop` lists): an `activate` or
   * `deactivate` record by the host, except a refusal repeating the host's last one for a build
   * still in its `run` (answered `recorded: null`). Or a retired build's worker and snapshot removed
   * from the host (`removed`, §6.1 step 7): a `retire` record by the host citing the build record,
   * and the host no longer holds it (its `heldBy` drops the host at once; the next inventory says
   * the same). Readiness still comes from the relay.
   */
  hostWorkerReport: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat, prov } = catalogOf(deps);
    const b = asRecord(ctx.body);
    const event = b.event;
    if (
      event !== 'attached' &&
      event !== 'refused' &&
      event !== 'detached' &&
      event !== 'removed'
    ) {
      throw new CpError('invalid_request', 'event must be attached, refused, detached or removed');
    }
    const buildId = typeof b.buildId === 'string' ? b.buildId : '';
    // A retired build's worker is stopped (§5.1), so `detached` is taken for one too; `removed` is
    // taken for a retired build only.
    const ok = (x: { status: string }) =>
      event === 'removed'
        ? x.status === 'retired'
        : x.status === 'registered' || (event === 'detached' && x.status === 'retired');
    const docs = await cat.list();
    const doc = docs.find((d) => d.builds.some((x) => x.buildId === buildId && ok(x)));
    const mine = deps.hosts?.get(host);
    if (!doc || mine?.holds[buildId] === undefined) {
      throw new CpError(
        'not_found',
        event === 'removed'
          ? 'no retired build this host holds'
          : event === 'detached'
            ? 'no registered or retired build this host holds'
            : 'no registered build this host holds',
      );
    }
    const target = doc.builds.find((x) => x.buildId === buildId && ok(x))!;
    // The wanted state never asks for this one's removal; a report of it would drop the live
    // build's host from its heldBy.
    if (event === 'removed' && liveSnapshots(docs)(target)) {
      throw new CpError(
        'build_in_use',
        'a build that is not retired shares this snapshot or worker; it is not removed',
      );
    }
    const reason = typeof b.reason === 'string' ? b.reason.slice(0, 1024) : undefined;
    // What the host runs, as placement counts it, without waiting for its next inventory: started
    // (attached) runs; stopped (detached) and not started (refused) do not.
    const st = deps.hosts!.get(host)!;
    const others = st.running.filter((x) => x !== buildId);
    st.running = event === 'attached' ? [...others, buildId] : others;
    // A refusal the same as this host's last one for a build it is still asked to run (the agent
    // retries every 15 s: a worker not installed, a unit whose start keeps failing) is not appended
    // again: the template's stream is append-only provenance, and would grow by one record a poll.
    st.refused ??= {};
    if (event === 'refused') {
      if (st.refused[buildId] === (reason ?? '')) {
        return { status: 200, body: { recorded: null } };
      }
      st.refused[buildId] = reason ?? '';
    } else {
      delete st.refused[buildId];
    }
    await prov.append({
      stream: `template/${doc.id}`,
      kind: event === 'removed' ? 'retire' : event === 'detached' ? 'deactivate' : 'activate',
      subject: `host:${host}`,
      body: {
        buildId,
        event,
        ...(event === 'removed'
          ? {
              buildRecord: await buildRecordOf(prov, doc.id, target),
            }
          : {}),
        ...(reason ? { reason } : {}),
      },
    });
    // The snapshot is gone from the host: it no longer holds the build, so `heldBy` drops it now
    // rather than at the agent's next inventory.
    if (event === 'removed') {
      const holds = { ...mine!.holds };
      delete holds[buildId];
      deps.hosts!.set(host, { ...mine!, holds });
    }
    return { status: 200, body: { recorded: event } };
  },

  hostInventory: async (ctx, deps) => {
    const host = hostOf(ctx);
    const b = asRecord(ctx.body);
    const holds: Record<string, string> = {};
    const running: string[] = [];
    const inv = Array.isArray(b.holds) ? b.holds : [];
    for (const h of inv) {
      const r = asRecord(h);
      if (
        typeof r.manifestHash === 'string' &&
        MANIFEST_HASH_RE.test(r.manifestHash) &&
        typeof r.template === 'string'
      ) {
        holds[r.manifestHash] = r.template;
        if (r.running === true) running.push(r.manifestHash);
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
    // A host's unrepeated refusals outlive its inventories (each poll replaces the rest).
    const refused = deps.hosts?.get(host)?.refused ?? {};
    deps.hosts?.set(host, { at: seconds(deps), holds, running, refused, limits });
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
    // A quick refusal on what this request read; the same check runs again inside every write
    // below, in the template's update queue, because the build can change in between (an owner's
    // cancel), and a report never overwrites a build the host may no longer report on.
    reportable(build, host);
    const withBuild = (mutate: (y: TemplateBuild, c: TemplateDoc) => Promise<TemplateDoc>) =>
      cat.update(doc.id, async (cur) => {
        const y = cur?.builds.find((x) => x.handle === build.handle);
        if (!cur || !y) throw new CpError('not_found', 'no such build claimed by this host');
        reportable(y, host);
        return mutate(y, cur);
      });
    const patched = (c: TemplateDoc, y: TemplateBuild, patch: Partial<TemplateBuild>) => ({
      ...c,
      builds: c.builds.map((x) => (x === y ? { ...x, ...patch } : x)),
    });
    if (event === 'building' || event === 'probing') {
      await withBuild(async (y, c) => patched(c, y, { status: event }));
      return { status: 200, body: { status: event } };
    }
    if (event === 'failed') {
      const step = typeof b.step === 'string' ? b.step.slice(0, 64) : 'unknown';
      const message = typeof b.message === 'string' ? b.message.slice(0, 4096) : 'the build failed';
      // The record is written inside the update, so a refused report leaves none.
      await withBuild(async (y, c) => {
        await prov.append({
          stream,
          kind: 'build',
          subject: `host:${host}`,
          body: { handle: build.handle!, outcome: 'failed', step, message },
        });
        return patched(c, y, { status: 'failed', reason: { message, step } });
      });
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
    const { record: policyRecord } = await policy.current();
    const manifestHash = String(t.manifest_hash);
    // Set inside the update (a closure TypeScript's narrowing does not follow).
    const verdict: { failed?: { rule: string; message?: string } } = {};
    // The status re-check, the registration check and both records happen inside the update, so
    // a cancel either lands first (this report is refused, and no record says it registered) or
    // after (it finds the build registered or rejected, and refuses).
    await withBuild(async (y, c) => {
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
      const results = registrationResults(y, t, sm);
      // A build id names one build of a template: a second build of the same snapshot (the same
      // image and spec, created again with another gate record or profile) is not registered
      // beside the first.
      const twin = c.builds.find((x) => x !== y && x.buildId === manifestHash);
      results.push(
        twin
          ? {
              rule: 'T.unique',
              passed: false,
              message: `another build of this template (${twin.handle ?? twin.buildId}, ${twin.status}) already has this manifest hash`,
            }
          : { rule: 'T.unique', passed: true },
      );
      const failed = results.find((r) => !r.passed);
      verdict.failed = failed;
      await prov.append({
        stream,
        kind: 'check',
        subject: 'policy',
        body: {
          policy: policyRecord,
          profile: y.profile,
          at: 'registration',
          build: recordDigest(buildRec.record),
          outcome: failed ? 'rejected' : 'registered',
          results: results as unknown as Record<string, unknown>[],
        },
      });
      const next = failed
        ? patched(c, y, {
            status: 'rejected',
            reason: { message: failed.message ?? failed.rule, rule: failed.rule },
          })
        : patched(c, y, {
            status: 'registered',
            buildId: manifestHash,
            worker: String(t.worker ?? ''),
          });
      // A first registered build of a template takes `default` (§3.2); later ones are tagged by the owner.
      return !failed && c.tags.default === undefined
        ? { ...next, tags: { ...c.tags, default: manifestHash } }
        : next;
    });
    const { failed } = verdict;
    const outcome = failed ? 'rejected' : 'registered';
    return {
      status: 200,
      body: { status: outcome, ...(failed ? { rule: failed.rule } : { buildId: manifestHash }) },
    };
  },
};
