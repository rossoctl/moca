import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSigner, workloadKeyFor, workloadRecordKey } from '@moca/control-plane';
import { orphanSweeper, redisRecords } from '../src/main.js';
import {
  deleteWorkload,
  putWorkload,
  sweepOrphans,
  type ProvisionerConfig,
  type ProvisionerDeps,
  type RecordStore,
  type WorkloadRef,
} from '../src/provisioner.js';
import { BundleStore } from '../src/seed.js';
import { FakeKube, workloadTemplate } from './fake-kube.js';

// The orphan sweep (spec §6.2): a workload's objects go once its Redis record is missing, deleted,
// deleting or of another generation, and all of them are older than the grace; on a missing record
// the PVC stays. Delete-only, and conservative: anything it cannot read as the provisioner wrote it
// is skipped, never deleted, and a Redis that looks emptied stops the pass.

const signer = makeSigner(
  generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
);
const config: ProvisionerConfig = {
  maxPerWorkload: 2,
  maxPerOwner: 4,
  attachTtlS: 86400,
  storage: { maxMiB: 10 * 1024, classes: new Map() },
  seedUrl: 'http://moca-provisioner.moca.svc:8081/seed/v1/bundle',
  maxEntries: 10_000,
};
const GRACE = 600;
const T0 = 1_800_000_000;
const MOUNTED = {
  count: 1,
  tier: 'container' as const,
  revision: 'c'.repeat(64),
  mount: 'read-only' as const,
  storage: { size: '1Gi', access: 'rwo' as const },
};

/** The workload records, as workloads.ts writes them, in a Map. */
class Records implements RecordStore {
  map = new Map<string, string>();
  reads: string[] = [];
  async get(key: string) {
    this.reads.push(key);
    await new Promise((r) => setImmediate(r));
    return this.map.get(key) ?? null;
  }
  put(r: WorkloadRef, status: string, generation = r.generation) {
    const rec = { name: r.name, owner: r.owner, generation, status, contextType: 'workspace' };
    this.map.set(workloadRecordKey(r.owner, r.name), JSON.stringify(rec));
  }
}

let kube: FakeKube;
let records: Records;
let now: number;
let deps: ProvisionerDeps & { records: Records };
let logs: string[];
let errors: string[];

const ref = (owner = 'github:alice', name = 'demo'): WorkloadRef => ({
  owner,
  name,
  generation: randomUUID(),
});
const wlOf = (r: WorkloadRef) => workloadKeyFor(r.owner, r.name, r.generation);
/** Every object of the workload still there, by kind. */
const left = (r: WorkloadRef) => {
  const wl = wlOf(r);
  return {
    sts: kube.objects.statefulsets.has(wl),
    svc: kube.objects.services.has(wl),
    secret: kube.objects.secrets.has(`${wl}-attach`),
    pvc: kube.objects.persistentvolumeclaims.has(wl),
  };
};
const ALL = { sts: true, svc: true, secret: true, pvc: true };
const NONE = { sts: false, svc: false, secret: false, pvc: false };
/** What a missing record leaves: the PVC, never deleted on that alone. */
const CLAIM_ONLY = { ...NONE, pvc: true };

beforeEach(() => {
  kube = new FakeKube();
  kube.objects.podtemplates.set('moca-workload-sandbox', workloadTemplate());
  records = new Records();
  now = T0;
  kube.clock = () => now * 1000;
  deps = {
    kube,
    signer,
    config,
    bundles: new BundleStore(1024 * 1024),
    records,
    now: () => now,
  };
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(String(m)));
});

describe('the orphan sweep: what goes', () => {
  it('a workload with no record: kept within the grace, its sandboxes deleted after it, its PVC kept', async () => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    expect(left(r)).toEqual(ALL);
    now += GRACE - 1;
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 0, skipped: 0, failed: 0, kept: 0 });
    expect(left(r)).toEqual(ALL);
    now += 1;
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 1, skipped: 0, failed: 0, kept: 1 });
    // A missing record cannot be told from an emptied Redis: the storage stays (spec §6.2).
    expect(left(r)).toEqual(CLAIM_ONLY);
    const wl = wlOf(r);
    // Each one logged by kind, name and reason; never a token or the owner.
    expect(logs).toEqual([
      `provisioner: orphan sweep deleted StatefulSet ${wl} (record missing)`,
      `provisioner: orphan sweep deleted Secret ${wl}-attach (record missing)`,
      `provisioner: orphan sweep deleted Service ${wl} (record missing)`,
    ]);
    expect(errors).toEqual([`provisioner: orphan sweep kept PVC ${wl}: record missing`]);
    expect(logs.join() + errors.join()).not.toContain('alice');
    expect(kube.calls).not.toContain(`delete persistentvolumeclaims ${wl}`);
  });

  it('a PVC kept on a missing record stays on later passes, and goes once the record says deleted', async () => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    now += GRACE;
    await sweepOrphans(deps, GRACE);
    expect(left(r)).toEqual(CLAIM_ONLY);
    errors = [];
    kube.calls = [];
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 0, skipped: 0, failed: 0, kept: 1 });
    expect(left(r)).toEqual(CLAIM_ONLY);
    expect(kube.calls.some((c) => c.startsWith('delete '))).toBe(false);
    expect(errors).toEqual([`provisioner: orphan sweep kept PVC ${wlOf(r)}: record missing`]);
    // An explicit deleted (or deleting, or another generation) is what deletes storage.
    records.put(r, 'deleted');
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 1, skipped: 0, failed: 0, kept: 0 });
    expect(left(r)).toEqual(NONE);
    expect(logs).toContain(
      `provisioner: orphan sweep deleted PersistentVolumeClaim ${wlOf(r)} (record deleted)`,
    );
  });

  it("deletes in removeWorkload's order: StatefulSet, Secret, Service, the PVC last", async () => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    records.put(r, 'deleted');
    now += GRACE;
    kube.calls = [];
    await sweepOrphans(deps, GRACE);
    const wl = wlOf(r);
    expect(kube.calls.filter((c) => c.startsWith('delete '))).toEqual([
      `delete statefulsets ${wl}`,
      `delete secrets ${wl}-attach`,
      `delete services ${wl}`,
      `delete persistentvolumeclaims ${wl}`,
    ]);
    // Delete-only: it creates, replaces and patches nothing, and mints no token.
    expect(kube.calls.some((c) => /^(create|replace|patch) /.test(c))).toBe(false);
  });

  it.each([
    ['deleted', 'record deleted'],
    ['deleting', 'record deleting'],
  ])('a record %s: deleted after the grace', async (status, why) => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    records.put(r, status);
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ swept: 1 });
    expect(left(r)).toEqual(NONE);
    expect(logs[0]).toContain(`(${why})`);
  });

  it('a record of another generation (the name re-created): the old objects go, the new stay', async () => {
    const old = ref();
    await putWorkload(deps, old, { count: 1, tier: 'container' });
    now += GRACE;
    const fresh = { ...old, generation: randomUUID() };
    await putWorkload(deps, fresh, { count: 1, tier: 'container' });
    records.put(fresh, 'provisioning');
    now += 1;
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 1, skipped: 0, failed: 0, kept: 0 });
    expect(left(old)).toMatchObject({ sts: false, svc: false, secret: false });
    expect(left(fresh)).toMatchObject({ sts: true, svc: true, secret: true });
    expect(logs[0]).toContain('(record of another generation)');
  });

  it('frees the owner cap: counted from StatefulSets, so a PUT the cap refused then fits', async () => {
    const alice = 'github:alice';
    const orphan = ref(alice, 'orphan');
    await putWorkload(deps, orphan, { count: 2, tier: 'container' });
    const live = ref(alice, 'live');
    await putWorkload(deps, live, { count: 2, tier: 'container' });
    records.put(live, 'ready');
    // maxPerOwner is 4: two and two are all of it.
    await expect(
      putWorkload(deps, ref(alice, 'third'), { count: 1, tier: 'container' }),
    ).rejects.toMatchObject({ code: 'owner_sandbox_quota_exceeded' });
    now += GRACE;
    await sweepOrphans(deps, GRACE);
    expect(left(orphan).sts).toBe(false);
    await putWorkload(deps, ref(alice, 'third'), { count: 2, tier: 'container' });
  });

  it('a PVC its finalizer holds stays reported, and the next pass deletes it', async () => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    records.put(r, 'deleted');
    now += GRACE;
    // The API server's view of a delete under kubernetes.io/pvc-protection: stays, marked.
    const del = kube.delete.bind(kube);
    let held = true;
    kube.delete = async (kind, name) => {
      if (kind === 'persistentvolumeclaims' && held) {
        kube.objects.persistentvolumeclaims.get(name)!.metadata.deletionTimestamp = 'x';
        return true;
      }
      return del(kind, name);
    };
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ swept: 1 });
    expect(left(r)).toEqual({ ...NONE, pvc: true });
    // The next pass sees it going, and issues no second delete while it is marked.
    kube.calls = [];
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 0, skipped: 0, failed: 0, kept: 0 });
    expect(kube.calls.some((c) => c.startsWith('delete '))).toBe(false);
    // Once its pod is gone the finalizer lets go, and nothing of the workload is listed again.
    held = false;
    kube.objects.persistentvolumeclaims.delete(wlOf(r));
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 0, skipped: 0, failed: 0, kept: 0 });
  });

  it('a Secret left alone after a failed delete goes with the next sweep of its Service', async () => {
    const r = ref();
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    now += GRACE;
    const del = kube.delete.bind(kube);
    let fail = true;
    kube.delete = async (kind, name) => {
      if (kind === 'secrets' && fail) throw new Error('Kubernetes API DELETE answered 500');
      return del(kind, name);
    };
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ failed: 1 });
    // The Service was not deleted yet (the Secret goes before it), so the next pass sees the group.
    expect(left(r)).toMatchObject({ sts: false, svc: true, secret: true });
    fail = false;
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ swept: 1 });
    expect(left(r)).toMatchObject({ svc: false, secret: false });
  });
});

describe('the orphan sweep: what stays', () => {
  it.each(['creating', 'awaiting_upload', 'provisioning', 'ready'])(
    'a live %s record of the same generation: untouched',
    async (status) => {
      const r = ref();
      await putWorkload(deps, r, MOUNTED);
      records.put(r, status);
      now += 10 * GRACE;
      kube.calls = [];
      expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 0, skipped: 0, failed: 0, kept: 0 });
      expect(left(r)).toEqual(ALL);
      expect(kube.calls.some((c) => c.startsWith('delete '))).toBe(false);
    },
  );

  it('an object with no record-key annotation is skipped and logged, never deleted', async () => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    delete kube.objects.services.get(wlOf(r))!.metadata.annotations['moca.dev/record-key'];
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 0, skipped: 1, failed: 0, kept: 0 });
    // The whole workload stays: its other objects are not judged without it.
    expect(left(r)).toEqual(ALL);
    expect(errors).toEqual([
      `provisioner: orphan sweep skips workload ${wlOf(r)}: Service ${wlOf(r)}: no valid record key`,
    ]);
    expect(records.reads).toEqual([]);
  });

  it.each([
    ['a malformed record key', 'moca.dev/record-key', 'sh:wl:nope'],
    ["another owner's record key", 'moca.dev/record-key', `sh:wl:${'f'.repeat(32)}:demo`],
    ['a malformed generation', 'moca.dev/generation', 'not-a-uuid'],
  ])('%s is skipped, never deleted', async (_, key, value) => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    kube.objects.statefulsets.get(wlOf(r))!.metadata.annotations[key] = value;
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ swept: 0, skipped: 1 });
    expect(left(r)).toEqual(ALL);
  });

  it('objects of one workload that disagree on their record are skipped', async () => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    kube.objects.persistentvolumeclaims.get(wlOf(r))!.metadata.annotations['moca.dev/generation'] =
      randomUUID();
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ swept: 0, skipped: 1 });
    expect(left(r)).toEqual(ALL);
    expect(errors[0]).toContain("disagrees with the workload's other objects");
  });

  it('an object with no creation time is skipped, never deleted', async () => {
    const r = ref();
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    delete kube.objects.statefulsets.get(wlOf(r))!.metadata.creationTimestamp;
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ swept: 0, skipped: 1 });
    expect(left(r)).toMatchObject({ sts: true, svc: true, secret: true });
  });

  it('the grace counts from the youngest object: a claim created late keeps them all', async () => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    kube.objects.persistentvolumeclaims.get(wlOf(r))!.metadata.creationTimestamp = new Date(
      (T0 + 300) * 1000,
    ).toISOString();
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ swept: 0 });
    expect(left(r)).toEqual(ALL);
  });

  it.each([
    ['does not parse', 'not json'],
    ['has no generation or status', '{"name":"demo"}'],
  ])('a record that %s keeps its objects', async (_, raw) => {
    const r = ref();
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    records.map.set(workloadRecordKey(r.owner, r.name), raw);
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ swept: 0, skipped: 1 });
    expect(left(r)).toMatchObject({ sts: true, svc: true, secret: true });
  });

  it('a same-generation record the workload key does not derive from keeps its objects', async () => {
    const r = ref();
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    // The right key and generation, but another owner inside: not what a PUT made.
    const rec = {
      name: r.name,
      owner: 'github:mallory',
      generation: r.generation,
      status: 'deleted',
    };
    records.map.set(workloadRecordKey(r.owner, r.name), JSON.stringify(rec));
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ swept: 0, skipped: 1 });
    expect(left(r)).toMatchObject({ sts: true, svc: true, secret: true });
  });

  it('never touches the shared pool or objects without its labels', async () => {
    kube.objects.statefulsets.set('moca-sandbox', {
      metadata: { name: 'moca-sandbox', labels: { app: 'moca-sandbox' } },
    });
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 0, skipped: 0, failed: 0, kept: 0 });
    expect(kube.objects.statefulsets.has('moca-sandbox')).toBe(true);
  });
});

describe('the orphan sweep: isolation and ordering', () => {
  it("one workload's failure never stops the others", async () => {
    const a = ref('github:alice', 'a');
    const b = ref('github:bob', 'b');
    const c = ref('github:carol', 'c');
    for (const r of [a, b, c]) {
      await putWorkload(deps, r, { count: 1, tier: 'container' });
      records.put(r, 'deleted');
    }
    now += GRACE;
    const get = records.get.bind(records);
    records.get = async (key) => {
      if (key === workloadRecordKey(b.owner, b.name)) throw new Error('redis: connection lost');
      return get(key);
    };
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 2, skipped: 0, failed: 1, kept: 0 });
    expect(left(a).sts).toBe(false);
    expect(left(b)).toMatchObject({ sts: true, svc: true, secret: true });
    expect(left(c).sts).toBe(false);
    expect(errors).toEqual([
      `provisioner: orphan check of workload ${wlOf(b)} failed: redis: connection lost`,
    ]);
  });

  it('a delete that throws mid-workload is logged, and the next workload is still swept', async () => {
    const a = ref('github:alice', 'a');
    const b = ref('github:bob', 'b');
    await putWorkload(deps, a, { count: 1, tier: 'container' });
    await putWorkload(deps, b, { count: 1, tier: 'container' });
    records.put(a, 'deleted');
    records.put(b, 'deleted');
    now += GRACE;
    const del = kube.delete.bind(kube);
    kube.delete = async (kind, name) => {
      if (name === wlOf(a) && kind === 'statefulsets') throw new Error('admission denied');
      return del(kind, name);
    };
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 1, skipped: 0, failed: 1, kept: 0 });
    expect(left(a).sts).toBe(true);
    expect(left(b)).toMatchObject({ sts: false, svc: false, secret: false });
  });

  it("is serialized with the owner's PUT: a sweep racing a re-create never deletes the new objects", async () => {
    const r = ref();
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    records.put(r, 'ready');
    now += GRACE;
    // The sweep's first look sees the record gone (a DELETE finished its record but not its
    // objects); a PUT of the same workload, already on the owner's queue, then makes it live again.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    const create = kube.create.bind(kube);
    kube.create = async (kind, obj) => {
      if (kind === 'services') {
        reached = true;
        await gate;
      }
      return create(kind, obj);
    };
    // The Service is gone, so the PUT re-creates it and blocks there, on Alice's queue.
    kube.objects.services.delete(wlOf(r));
    const put = putWorkload(deps, r, { count: 1, tier: 'container' });
    await vi.waitFor(() => expect(reached).toBe(true));
    records.map.clear();
    let swept = false;
    const sweep = sweepOrphans(deps, GRACE).then((v) => ((swept = true), v));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Its delete waits behind the PUT, not beside it.
    expect(swept).toBe(false);
    expect(left(r).sts).toBe(true);
    // The PUT lands and the record is live again before the sweep's turn comes.
    records.put(r, 'ready');
    release();
    await put;
    expect(await sweep).toEqual({ swept: 0, skipped: 0, failed: 0, kept: 0 });
    expect(left(r)).toMatchObject({ sts: true, svc: true, secret: true });
    // The Service the PUT re-created is young: no delete was even judged for it.
    expect(kube.calls.filter((c) => c.startsWith('delete '))).toEqual([]);
  });

  it('the main loop sweeps only while Redis is ready, one pass at a time', async () => {
    const r = ref();
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    now += GRACE;
    let ready = false;
    const sweep = orphanSweeper(
      { ...deps, records: Object.assign(records, { ready: () => ready }) },
      GRACE,
    );
    await sweep();
    expect(left(r).sts).toBe(true);
    expect(errors).toContain('provisioner: orphan sweep skipped: Redis is not ready');
    ready = true;
    const [p1, p2] = [sweep(), sweep()];
    expect(p1).toBe(p2);
    await p1;
    expect(left(r).sts).toBe(false);
    expect(logs).toContain('provisioner: swept 1 orphaned workload(s)');
  });

  it("is serialized with the owner's PUT: the re-read record under the queue keeps old objects", async () => {
    // All objects old, the record missing at the first look, and live again by the time the sweep
    // holds Alice's queue. The PUT re-creates nothing (a scale-up of objects that all exist), so
    // only the second record read can keep them: the grace re-check sees nothing young.
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    records.put(r, 'ready');
    now += GRACE;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    const list = kube.list.bind(kube);
    kube.list = async (kind, selector) => {
      // The PUT's owner-cap count, not the sweep's own list.
      if (kind === 'statefulsets' && selector.startsWith('moca.dev/owner=')) {
        reached = true;
        await gate;
      }
      return list(kind, selector);
    };
    const put = putWorkload(deps, r, { ...MOUNTED, count: 2 });
    await vi.waitFor(() => expect(reached).toBe(true));
    records.map.clear();
    let swept = false;
    const sweep = sweepOrphans(deps, GRACE).then((v) => ((swept = true), v));
    // The first look has read the record (missing) and the delete is waiting behind the PUT.
    await vi.waitFor(() => expect(records.reads.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(swept).toBe(false);
    records.put(r, 'ready');
    release();
    await put;
    expect(await sweep).toEqual({ swept: 0, skipped: 0, failed: 0, kept: 0 });
    expect(records.reads.length).toBe(2);
    expect(left(r)).toEqual(ALL);
    expect(kube.calls.filter((c) => c.startsWith('delete '))).toEqual([]);
    // Nothing young: the objects the second read kept are all past the grace.
    for (const kind of ['statefulsets', 'services', 'persistentvolumeclaims'] as const) {
      const at = Date.parse(kube.objects[kind].get(wlOf(r))!.metadata.creationTimestamp!);
      expect(now - at / 1000).toBeGreaterThanOrEqual(GRACE);
    }
  });
});

describe('the orphan sweep: a Redis that does not answer', () => {
  const hang = () => new Promise<string | null>(() => {});

  it('a first read that never answers fails that workload once the timeout passes, objects kept', async () => {
    const a = ref('github:alice', 'a');
    const b = ref('github:bob', 'b');
    await putWorkload(deps, a, { count: 1, tier: 'container' });
    await putWorkload(deps, b, { count: 1, tier: 'container' });
    records.put(b, 'deleted');
    now += GRACE;
    const get = records.get.bind(records);
    records.get = (key) => (key === workloadRecordKey(a.owner, a.name) ? hang() : get(key));
    expect(await sweepOrphans(deps, GRACE, 50)).toEqual({
      swept: 1,
      skipped: 0,
      failed: 1,
      kept: 0,
    });
    expect(left(a)).toMatchObject({ sts: true, svc: true, secret: true });
    expect(left(b)).toMatchObject({ sts: false, svc: false, secret: false });
    expect(errors).toEqual([
      `provisioner: orphan check of workload ${wlOf(a)} failed: Redis read timed out after 50 ms`,
    ]);
  });

  it("a read on the owner's queue that never answers releases the queue at the timeout, and the next pass runs", async () => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    records.put(r, 'deleted');
    now += GRACE;
    // The first look reads `deleted`; the re-read under Alice's queue hangs (a blackholed socket).
    const get = records.get.bind(records);
    let reads = 0;
    let hung = false;
    records.get = (key) => {
      if (++reads === 2) {
        hung = true;
        return hang();
      }
      return get(key);
    };
    const sweep = orphanSweeper(
      { ...deps, records: Object.assign(records, { ready: () => true }) },
      GRACE,
      100,
    );
    const pass = sweep();
    await vi.waitFor(() => expect(hung).toBe(true));
    // Alice's DELETE queues behind the sweep's hung read, and runs once the timeout releases it.
    const started = Date.now();
    const del = deleteWorkload(deps, r);
    expect(await del).toMatchObject({ remaining: expect.any(Number) });
    expect(Date.now() - started).toBeLessThan(2000);
    await pass;
    expect(errors).toContain(
      `provisioner: orphan check of workload ${wlOf(r)} failed: Redis read timed out after 100 ms`,
    );
    // The sweep itself deleted nothing: the DELETE did.
    expect(logs.filter((l) => l.includes('orphan sweep deleted'))).toEqual([]);
    // The pass ended, so the next one starts (not the same promise) and runs to the end.
    const r2 = ref('github:alice', 'next');
    await putWorkload(deps, r2, { count: 1, tier: 'container' });
    records.put(r2, 'deleted');
    now += GRACE;
    const next = sweep();
    expect(next).not.toBe(pass);
    await next;
    expect(left(r2).sts).toBe(false);
  });

  it('a PUT queued behind a hung re-read waits no longer than the timeout, and its objects stay', async () => {
    const r = ref();
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    now += GRACE;
    const get = records.get.bind(records);
    let reads = 0;
    let hung = false;
    records.get = (key) => {
      if (++reads === 2) {
        hung = true;
        return hang();
      }
      return get(key);
    };
    const sweep = sweepOrphans(deps, GRACE, 100);
    await vi.waitFor(() => expect(hung).toBe(true));
    const started = Date.now();
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await sweep).toEqual({ swept: 0, skipped: 0, failed: 1, kept: 0 });
    expect(left(r)).toMatchObject({ sts: true, svc: true, secret: true });
  });
});

describe('the orphan sweep: a Redis that looks emptied', () => {
  it('every record missing (two or more workloads): the pass deletes nothing and says so', async () => {
    const rs = [ref('github:alice', 'a'), ref('github:bob', 'b')];
    for (const r of rs) await putWorkload(deps, r, MOUNTED);
    now += GRACE;
    kube.calls = [];
    expect(await sweepOrphans(deps, GRACE)).toEqual({
      swept: 0,
      skipped: 0,
      failed: 0,
      kept: 0,
      aborted: true,
    });
    for (const r of rs) expect(left(r)).toEqual(ALL);
    expect(kube.calls.some((c) => c.startsWith('delete '))).toBe(false);
    expect(errors).toEqual([
      expect.stringContaining('ORPHAN SWEEP ABORTED, nothing deleted: 2 of the 2'),
    ]);
  });

  it('more than half missing aborts, even with deletable deleted records among them', async () => {
    const rs = ['a', 'b', 'c', 'd', 'e'].map((n) => ref(`github:${n}`, n));
    for (const r of rs) await putWorkload(deps, r, { count: 1, tier: 'container' });
    records.put(rs[0], 'ready');
    records.put(rs[1], 'deleted');
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toMatchObject({ swept: 0, aborted: true });
    for (const r of rs) expect(left(r)).toMatchObject({ sts: true, svc: true, secret: true });
    expect(errors.join()).toContain('3 of the 5 workload records read are missing');
  });

  it('half missing or fewer is a normal pass; the kept claims do not count toward the next guard', async () => {
    const rs = ['a', 'b', 'c', 'd'].map((n) => ref('github:alice', n));
    for (const r of rs) await putWorkload(deps, r, { ...MOUNTED, count: 1 });
    records.put(rs[0], 'ready');
    records.put(rs[1], 'ready');
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 2, skipped: 0, failed: 0, kept: 2 });
    expect(left(rs[2])).toEqual(CLAIM_ONLY);
    expect(left(rs[3])).toEqual(CLAIM_ONLY);
    // Two lone claims, two live workloads: the claims are not read as a mostly-missing Redis.
    errors = [];
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 0, skipped: 0, failed: 0, kept: 2 });
    expect(errors.join()).not.toContain('ABORTED');
  });

  it('orphanSweeper says how many PVCs are kept on missing records, every pass', async () => {
    const r = ref();
    await putWorkload(deps, r, MOUNTED);
    now += GRACE;
    const sweep = orphanSweeper(
      { ...deps, records: Object.assign(records, { ready: () => true }) },
      GRACE,
    );
    const summary =
      '1 PVC(s) kept on missing records; they count against the moca-sandbox ResourceQuota';
    await sweep();
    expect(errors.filter((l) => l.includes(summary))).toHaveLength(1);
    // The claim is still there on the next pass, and so is the summary: it is easy to miss once.
    errors = [];
    await sweep();
    expect(errors.filter((l) => l.includes(summary))).toHaveLength(1);
    // Once the record says deleted, the claim goes and the summary stops.
    records.put(r, 'deleted');
    errors = [];
    await sweep();
    expect(errors.some((l) => l.includes('kept on missing records'))).toBe(false);
  });

  it('a lone orphan with no record is still swept (one is not a pattern)', async () => {
    const r = ref();
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    now += GRACE;
    expect(await sweepOrphans(deps, GRACE)).toEqual({ swept: 1, skipped: 0, failed: 0, kept: 0 });
  });
});

describe('the orphan sweep against a real Redis (redisRecords)', () => {
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const client = createClient({ url });
  const keys: string[] = [];
  afterAll(async () => {
    if (keys.length) await client.del(keys);
    await client.quit();
  });

  it('reads records with GET and sweeps only the orphan', async () => {
    await client.connect();
    const store = redisRecords(url);
    // Closed even when an assertion fails: its reconnect loop would keep the worker alive.
    try {
      await vi.waitFor(() => expect(store.ready()).toBe(true));
      const d = { ...deps, records: store };
      const owner = `github:sweep-${randomUUID()}`;
      const live = ref(owner, 'live');
      const gone = ref(owner, 'gone');
      await putWorkload(d, live, { count: 1, tier: 'container' });
      await putWorkload(d, gone, { count: 1, tier: 'container' });
      for (const [r, status] of [
        [live, 'ready'],
        [gone, 'deleted'],
      ] as const) {
        const key = workloadRecordKey(r.owner, r.name);
        keys.push(key);
        await client.set(key, JSON.stringify({ ...r, status, contextType: 'workspace' }));
      }
      now += GRACE;
      expect(await sweepOrphans(d, GRACE)).toEqual({ swept: 1, skipped: 0, failed: 0, kept: 0 });
      expect(left(live)).toMatchObject({ sts: true, svc: true, secret: true });
      expect(left(gone)).toMatchObject({ sts: false, svc: false, secret: false });
    } finally {
      store.close();
    }
  });
});

// #626: on Kubernetes the provisioner reads Redis as its own ACL user, made by deploy/k8s/setup.sh
// from REDIS_PROVISIONER_ACL. The rules are read from the script itself, so what is held to a real
// Valkey here is exactly what a deployment gets: enough for node-redis's connect and the sweep's
// GETs, and nothing that writes -- sh:sandbox:records least of all, which picks every turn's executor.
describe("the orphan sweep as setup.sh's provisioner Redis user (#626)", () => {
  const SETUP_SH = new URL('../../../deploy/k8s/setup.sh', import.meta.url);
  const rules = /^REDIS_PROVISIONER_ACL='([^']*)'$/m.exec(readFileSync(SETUP_SH, 'utf8'))?.[1];
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const admin = createClient({ url });
  // A user of this run's own: a shared Redis may hold others'. The password is a throwaway.
  const user = `moca-provisioner-test-${randomUUID()}`;
  const password = `placeholder-${randomUUID()}`;
  const asUser = (() => {
    const u = new URL(url);
    u.username = user;
    u.password = password;
    return u.toString();
  })();
  const keys: string[] = [];
  beforeAll(async () => {
    if (rules === undefined) return; // the first test says why
    await admin.connect();
    // The line setup.sh writes to redis.conf, with the password in clear instead of its #<sha256>.
    await admin.sendCommand([
      'ACL',
      'SETUSER',
      user,
      'reset',
      'on',
      `>${password}`,
      ...rules.split(' '),
    ]);
  });
  afterAll(async () => {
    if (!admin.isOpen) return;
    if (keys.length) await admin.del(keys);
    await admin.sendCommand(['ACL', 'DELUSER', user]);
    await admin.quit();
  });

  it('is defined in setup.sh as GET on workload records only', () => {
    expect(rules, `no REDIS_PROVISIONER_ACL='...' line in ${SETUP_SH.pathname}`).toBeDefined();
    expect(rules!.split(' ')).toEqual(['~sh:wl:*', 'resetchannels', '+get']);
  });

  it('connects, and the sweep reads records with it', async () => {
    expect(rules, 'no REDIS_PROVISIONER_ACL in setup.sh').toBeDefined();
    const store = redisRecords(asUser);
    try {
      await vi.waitFor(() => expect(store.ready()).toBe(true));
      const d = { ...deps, records: store };
      const owner = `github:acl-${randomUUID()}`;
      const live = ref(owner, 'live');
      const gone = ref(owner, 'gone');
      await putWorkload(d, live, { count: 1, tier: 'container' });
      await putWorkload(d, gone, { count: 1, tier: 'container' });
      for (const [r, status] of [
        [live, 'ready'],
        [gone, 'deleted'],
      ] as const) {
        const key = workloadRecordKey(r.owner, r.name);
        keys.push(key);
        await admin.set(key, JSON.stringify({ ...r, status, contextType: 'workspace' }));
      }
      now += GRACE;
      expect(await sweepOrphans(d, GRACE)).toEqual({ swept: 1, skipped: 0, failed: 0, kept: 0 });
      expect(left(live)).toMatchObject({ sts: true, svc: true, secret: true });
      expect(left(gone)).toMatchObject({ sts: false, svc: false, secret: false });
    } finally {
      store.close();
    }
  });

  it('can write nothing, and read nothing but workload records', async () => {
    expect(rules, 'no REDIS_PROVISIONER_ACL in setup.sh').toBeDefined();
    const client = createClient({ url: asUser });
    client.on('error', () => {});
    await client.connect();
    try {
      const record = `sh:wl:${'0'.repeat(32)}:acl-${randomUUID().slice(0, 8)}`;
      keys.push(record);
      await expect(client.set(record, '{}')).rejects.toThrow(/NOPERM/);
      await expect(client.del(record)).rejects.toThrow(/NOPERM/);
      await expect(client.hSet('sh:sandbox:records', 'x', '{}')).rejects.toThrow(/NOPERM/);
      await expect(client.get('sh:sandbox:records')).rejects.toThrow(/NOPERM/);
      await expect(client.keys('sh:*')).rejects.toThrow(/NOPERM/);
      await expect(client.publish('sh:events', 'x')).rejects.toThrow(/NOPERM/);
      expect(await admin.exists(record)).toBe(0);
    } finally {
      client.destroy();
    }
  });
});
