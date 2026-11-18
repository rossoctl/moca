import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keyIdFor,
  makeSigner,
  ownerScopeFor,
  verifyAttachToken,
  workloadKeyFor,
} from '@moca/control-plane';
import {
  deleteWorkload,
  getWorkload,
  parseSandboxSpec,
  putBundle as holdBundle,
  putWorkload,
  remintExpiring,
  reserveBundle,
  settleSeeds,
  type ProvisionerConfig,
  type ProvisionerDeps,
  type WorkloadRef,
} from '../src/provisioner.js';
import { BundleStore } from '../src/seed.js';
import { FakeKube, workloadTemplate } from './fake-kube.js';

const { privateKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const publicKey = createPublicKey(privateKey);
const publicKeys = new Map([[keyIdFor(publicKey), publicKey]]);
const config: ProvisionerConfig = {
  maxPerWorkload: 2,
  maxPerOwner: 4,
  attachTtlS: 86400,
  storage: { maxMiB: 10 * 1024, classes: new Map() },
  seedUrl: 'http://moca-provisioner.moca.svc:8081/seed/v1/bundle',
  maxEntries: 10_000,
};
const stsOf = (wl: string) => kube.objects.statefulsets.get(wl)!;

let kube: FakeKube;
let now: number;
let deps: ProvisionerDeps;
const ref = (owner: string, name = 'demo', generation = randomUUID()): WorkloadRef => ({
  owner,
  name,
  generation,
});
/** A hand-off as the server makes it: reserve its bytes, hold it, give the reservation back. */
async function putBundle(d: ProvisionerDeps, r: WorkloadRef, bytes: Buffer) {
  const release = reserveBundle(d, r, bytes.length);
  try {
    return await holdBundle(d, r, bytes);
  } finally {
    release();
  }
}
const tokenIn = (wl: string) =>
  Buffer.from(kube.objects.secrets.get(`${wl}-attach`)!.data.token, 'base64').toString();

beforeEach(() => {
  kube = new FakeKube();
  kube.objects.podtemplates.set('moca-workload-sandbox', workloadTemplate());
  now = 1_800_000_000;
  deps = { kube, signer, config, bundles: new BundleStore(1024 * 1024), now: () => now };
});

describe('PUT: what a workload gets', () => {
  it('creates the Secret, headless Service and StatefulSet under the derived workload key', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    const status = await putWorkload(deps, r, { count: 2, tier: 'container' });
    expect(status).toMatchObject({ workloadId: 'demo', count: 2 });
    expect([...kube.objects.secrets.keys()]).toEqual([`${wl}-attach`]);
    expect([...kube.objects.services.keys()]).toEqual([wl]);
    const svc = kube.objects.services.get(wl)!;
    expect(svc.spec).toEqual({
      clusterIP: 'None',
      selector: { app: 'moca-workload-sandbox', 'moca.dev/workload': wl },
    });
    const sts = kube.objects.statefulsets.get(wl)!;
    expect(sts.spec.replicas).toBe(2);
    expect(sts.spec.serviceName).toBe(wl);
    expect(sts.spec.template.metadata.labels).toEqual({
      app: 'moca-workload-sandbox',
      'moca.dev/workload': wl,
      'moca.dev/owner': ownerScopeFor('github:alice'),
      'app.kubernetes.io/managed-by': 'moca-provisioner',
    });
    expect(sts.metadata.annotations).toMatchObject({
      'moca.dev/generation': r.generation,
      'moca.dev/record-key': `sh:wl:${ownerScopeFor('github:alice')}:demo`,
    });
    // The pods' own label, so the shared pool's selector (app: moca-sandbox) never matches them.
    expect(sts.spec.selector.matchLabels.app).toBe('moca-workload-sandbox');
  });

  it("mints a token whose binding is the workload's, verifiable with the public key only", async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    const c = verifyAttachToken(tokenIn(wl), publicKeys, { now });
    expect(c).toMatchObject({
      wl,
      own: ownerScopeFor('github:alice'),
      gen: r.generation,
      tr: 'container',
      n: 2,
      exp: now + 86400,
    });
  });

  it('builds the pod from the PodTemplate, adding only the binding and the attach token', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    const t = workloadTemplate().template;
    const tpl = stsOf(wl).spec.template;
    const pod = tpl.spec;
    expect(pod.serviceAccountName).toBe('moca-workload-sandbox');
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toEqual(t.spec.securityContext);
    // The template's annotations (kind's image ID) survive, under the binding's.
    expect(tpl.metadata.annotations).toMatchObject({
      'moca.dev/image-id': 'x',
      'moca.dev/generation': r.generation,
    });
    const [c] = pod.containers;
    expect(c.image).toBe(t.spec.containers[0].image);
    expect(c.securityContext).toEqual(t.spec.containers[0].securityContext);
    expect(c.resources).toEqual(t.spec.containers[0].resources);
    const env = Object.fromEntries(c.env.map((e: { name: string }) => [e.name, e]));
    expect(c.env).toHaveLength(5);
    expect(env.SANDBOX_TIER.value).toBe('container');
    expect(env.SANDBOX_TOKEN_FILE.value).toBe('/run/moca-attach/token');
    expect(env.RELAY_ADDR.value).toBe('sandbox-relay-attach.moca.svc:9443');
    // The idle reclaim (#338) passes through as the template's ConfigMap read, not a value.
    expect(env.SH_WORKSPACE_IDLE.valueFrom).toEqual(
      t.spec.containers[0].env.find((e: { name: string }) => e.name === 'SH_WORKSPACE_IDLE')
        .valueFrom,
    );
    expect(env.SANDBOX_ID.valueFrom).toEqual({ fieldRef: { fieldPath: 'metadata.name' } });
    // The attach token as a directory mount, never a subPath, so the kubelet refreshes it.
    expect(c.volumeMounts).toEqual([
      { name: 'workspace', mountPath: '/workspace' },
      { name: 'attach-token', mountPath: '/run/moca-attach', readOnly: true },
    ]);
    expect(pod.volumes).toEqual([
      { name: 'workspace', emptyDir: {} },
      { name: 'attach-token', secret: { secretName: `${wl}-attach`, defaultMode: 0o440 } },
    ]);
  });

  it('never reads a Secret: it writes them blind, and records the token on the StatefulSet', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    await remintExpiring(deps);
    await deleteWorkload(deps, r);
    expect(kube.calls.filter((c) => /^(get|list) secrets/.test(c))).toEqual([]);
  });

  it("records the token's expiry, issue time, signing key and n on the StatefulSet", async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    expect(stsOf(wl).metadata.annotations).toMatchObject({
      'moca.dev/attach-iat': String(now),
      'moca.dev/attach-exp': String(now + 86400),
      'moca.dev/attach-kid': signer.kid,
      'moca.dev/sandbox-count': '2',
    });
    // The Secret carries no copy of what the token says.
    expect(Object.keys(kube.objects.secrets.get(`${wl}-attach`)!.metadata.annotations)).toEqual([
      'moca.dev/record-key',
      'moca.dev/generation',
    ]);
  });

  it('is idempotent by (wl, gen): a repeat converges the same objects and keeps a fresh token', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    const first = tokenIn(wl);
    kube.calls = [];
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    expect(tokenIn(wl)).toBe(first);
    expect(kube.calls.filter((c) => /^(create|replace|patch)/.test(c))).toEqual([]);
  });

  it('a changed count re-mints the token for the new n and scales the StatefulSet', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    expect(verifyAttachToken(tokenIn(wl), publicKeys, { now }).n).toBe(2);
    expect(kube.objects.statefulsets.get(wl)!.spec.replicas).toBe(2);
  });

  it('a re-created workload (new generation) gets a different key and binding', async () => {
    const a = ref('github:alice', 'demo');
    const b = ref('github:alice', 'demo');
    await putWorkload(deps, a, { count: 1, tier: 'container' });
    await deleteWorkload(deps, a);
    await putWorkload(deps, b, { count: 1, tier: 'container' });
    const wlB = workloadKeyFor(b.owner, b.name, b.generation);
    expect(wlB).not.toBe(workloadKeyFor(a.owner, a.name, a.generation));
    expect(verifyAttachToken(tokenIn(wlB), publicKeys, { now }).gen).toBe(b.generation);
  });

  it('refuses when the PodTemplate is missing, creating nothing', async () => {
    kube.objects.podtemplates.clear();
    await expect(
      putWorkload(deps, ref('github:alice'), { count: 1, tier: 'container' }),
    ).rejects.toMatchObject({ status: 500, code: 'workload_template_missing' });
    expect(kube.objects.secrets.size).toBe(0);
  });

  it('overwrites a Secret left by an earlier, interrupted PUT instead of failing on it', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    kube.objects.secrets.set(`${wl}-attach`, {
      metadata: { name: `${wl}-attach` },
      data: { token: 'c3RhbGU=' },
    });
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    expect(verifyAttachToken(tokenIn(wl), publicKeys, { now }).wl).toBe(wl);
  });
});

describe('the owner boundary', () => {
  it("Alice's token cannot touch Bob's workload: the same name and generation derive another key", async () => {
    const gen = randomUUID();
    const bob = ref('github:bob', 'demo', gen);
    await putWorkload(deps, bob, { count: 1, tier: 'container' });
    const bobWl = workloadKeyFor('github:bob', 'demo', gen);
    // Alice names Bob's workload exactly.
    const alice = ref('github:alice', 'demo', gen);
    await expect(getWorkload(deps, alice)).rejects.toMatchObject({ status: 404 });
    await deleteWorkload(deps, alice);
    expect(kube.objects.statefulsets.has(bobWl)).toBe(true);
    expect(kube.objects.secrets.has(`${bobWl}-attach`)).toBe(true);
  });

  it('refuses to adopt an object under the derived name that is not this workload', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    kube.objects.statefulsets.set(wl, {
      metadata: { name: wl, labels: { 'moca.dev/workload': wl } },
      spec: { replicas: 1 },
    });
    await expect(putWorkload(deps, r, { count: 1, tier: 'container' })).rejects.toMatchObject({
      status: 409,
      code: 'workload_object_conflict',
    });
  });

  it('refuses to adopt a Service that appears between its pre-read and its create', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    const create = kube.create.bind(kube);
    kube.create = async (kind, obj) => {
      if (kind === 'services') {
        kube.objects.services.set(wl, {
          metadata: { name: wl, labels: { 'moca.dev/workload': wl } },
        });
      }
      return create(kind, obj);
    };
    await expect(putWorkload(deps, r, { count: 1, tier: 'container' })).rejects.toMatchObject({
      status: 409,
      code: 'workload_object_conflict',
    });
    expect(kube.objects.statefulsets.has(wl)).toBe(false);
  });

  it('refuses to adopt a StatefulSet that appears between its pre-read and its create', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    const create = kube.create.bind(kube);
    kube.create = async (kind, obj) => {
      if (kind === 'statefulsets') {
        kube.objects.statefulsets.set(wl, {
          metadata: { name: wl, labels: { 'moca.dev/workload': wl } },
          spec: { replicas: 1 },
        });
      }
      return create(kind, obj);
    };
    await expect(putWorkload(deps, r, { count: 1, tier: 'container' })).rejects.toMatchObject({
      status: 409,
      code: 'workload_object_conflict',
    });
  });
});

describe('caps (spec §6.3), enforced here too', () => {
  it('refuses a count above MOCA_WORKLOAD_MAX_SANDBOXES, a non-integer, and microvm', () => {
    expect(() => parseSandboxSpec({ count: 3 }, config)).toThrow(
      expect.objectContaining({ status: 400, code: 'sandboxes_count_exceeded' }),
    );
    for (const count of [0, -1, 1.5, '1', undefined]) {
      expect(() => parseSandboxSpec({ count }, config)).toThrow(
        expect.objectContaining({ code: 'sandboxes_count_invalid' }),
      );
    }
    expect(() => parseSandboxSpec({ count: 1, tier: 'microvm' }, config)).toThrow(
      expect.objectContaining({ code: 'sandbox_tier_unavailable' }),
    );
    expect(() => parseSandboxSpec({ count: 1, wl: 'w-x' }, config)).toThrow(
      expect.objectContaining({ code: 'sandboxes_field_not_allowed' }),
    );
    expect(parseSandboxSpec({ count: 2, revision: 'a'.repeat(64) }, config)).toEqual({
      count: 2,
      tier: 'container',
      revision: 'a'.repeat(64),
    });
  });

  it("refuses an owner's replicas across workloads beyond MOCA_OWNER_MAX_SANDBOXES", async () => {
    await putWorkload(deps, ref('github:alice', 'one'), { count: 2, tier: 'container' });
    await putWorkload(deps, ref('github:alice', 'two'), { count: 2, tier: 'container' });
    await expect(
      putWorkload(deps, ref('github:alice', 'three'), { count: 1, tier: 'container' }),
    ).rejects.toMatchObject({ status: 429, code: 'owner_sandbox_quota_exceeded' });
    // Another owner is not counted against Alice.
    await putWorkload(deps, ref('github:bob', 'one'), { count: 2, tier: 'container' });
  });

  it('serializes one owner: of two concurrent PUTs that together exceed the cap left, exactly one wins', async () => {
    await putWorkload(deps, ref('github:alice', 'one'), { count: 2, tier: 'container' });
    const results = await Promise.allSettled([
      putWorkload(deps, ref('github:alice', 'two'), { count: 2, tier: 'container' }),
      putWorkload(deps, ref('github:alice', 'three'), { count: 2, tier: 'container' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 429,
      code: 'owner_sandbox_quota_exceeded',
    });
    const total = [...kube.objects.statefulsets.values()].reduce((n, s) => n + s.spec.replicas, 0);
    expect(total).toBe(4);
  });

  it('serializes per owner only: another owner is not held behind', async () => {
    const [a, b] = await Promise.all([
      putWorkload(deps, ref('github:alice', 'one'), { count: 2, tier: 'container' }),
      putWorkload(deps, ref('github:bob', 'one'), { count: 2, tier: 'container' }),
    ]);
    expect([a.count, b.count]).toEqual([2, 2]);
  });

  it('never refuses a PUT that adds no replicas, even for an owner already over the cap', async () => {
    const r = ref('github:alice', 'one');
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    await putWorkload(deps, ref('github:alice', 'two'), { count: 2, tier: 'container' });
    // The operator lowers MOCA_OWNER_MAX_SANDBOXES below what Alice already has.
    const lowered = { ...deps, config: { ...config, maxPerOwner: 2 } };
    expect(await putWorkload(lowered, r, { count: 2, tier: 'container' })).toMatchObject({
      count: 2,
    });
    expect(await putWorkload(lowered, r, { count: 1, tier: 'container' })).toMatchObject({
      count: 1,
    });
    expect(stsOf(workloadKeyFor(r.owner, r.name, r.generation)).spec.replicas).toBe(1);
    // Growing again is held to the cap.
    await expect(putWorkload(lowered, r, { count: 2, tier: 'container' })).rejects.toMatchObject({
      status: 429,
      code: 'owner_sandbox_quota_exceeded',
    });
  });

  it("a repeat PUT does not count the workload's own replicas twice", async () => {
    const r = ref('github:alice', 'one');
    await putWorkload(deps, ref('github:alice', 'two'), { count: 2, tier: 'container' });
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    await putWorkload(deps, r, { count: 2, tier: 'container' });
  });
});

describe('DELETE: sandboxes first, done once no pod remains', () => {
  it('removes all three objects, and reports pods until the garbage collector has them', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    kube.runPods(wl);
    expect(await deleteWorkload(deps, r)).toEqual({ remaining: 2 });
    expect(kube.objects.statefulsets.has(wl)).toBe(false);
    expect(kube.objects.services.has(wl)).toBe(false);
    expect(kube.objects.secrets.has(`${wl}-attach`)).toBe(false);
    kube.reapPods();
    expect(await deleteWorkload(deps, r)).toEqual({ remaining: 0 });
  });

  it('waits for a PUT still converging: a DELETE during it leaves nothing, and frees the cap', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    // A slow API server: the PUT's StatefulSet create hangs until released, as when the worker's
    // MOCA_PROVISIONER_TIMEOUT_MS gives up on it and the client then deletes the workload.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    const create = kube.create.bind(kube);
    kube.create = async (kind, obj) => {
      if (kind === 'statefulsets') {
        reached = true;
        await gate;
      }
      return create(kind, obj);
    };
    const put = putWorkload(deps, r, { count: 2, tier: 'container' });
    await vi.waitFor(() => expect(reached).toBe(true));
    let deleted = false;
    const del = deleteWorkload(deps, r).then((v) => ((deleted = true), v));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Queued behind the PUT, not run beside it.
    expect(deleted).toBe(false);
    release();
    await put;
    expect(await del).toEqual({ remaining: 0 });
    expect(kube.objects.statefulsets.has(wl)).toBe(false);
    expect(kube.objects.services.has(wl)).toBe(false);
    expect(kube.objects.secrets.has(`${wl}-attach`)).toBe(false);
    // Nothing left counts toward Alice's cap.
    await putWorkload(deps, ref('github:alice', 'other'), { count: 2, tier: 'container' });
    await putWorkload(deps, ref('github:alice', 'third'), { count: 2, tier: 'container' });
  });

  it("waits for a re-mint's Secret write: a DELETE during it leaves no Secret behind", async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    now += 50_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    const replace = kube.replace.bind(kube);
    kube.replace = async (kind, obj) => {
      if (kind === 'secrets') {
        reached = true;
        await gate;
      }
      return replace(kind, obj);
    };
    const remint = remintExpiring(deps);
    await vi.waitFor(() => expect(reached).toBe(true));
    const del = deleteWorkload(deps, r);
    release();
    expect(await remint).toBe(1);
    expect(await del).toEqual({ remaining: 0 });
    expect(kube.objects.secrets.has(`${wl}-attach`)).toBe(false);
    expect(kube.objects.statefulsets.has(wl)).toBe(false);
  });

  it('tolerates objects already gone, and never deletes the shared pool', async () => {
    kube.objects.statefulsets.set('moca-sandbox', { metadata: { name: 'moca-sandbox' } });
    expect(await deleteWorkload(deps, ref('github:alice'))).toEqual({ remaining: 0 });
    expect(kube.objects.statefulsets.has('moca-sandbox')).toBe(true);
  });
});

describe('re-minting before expiry (spec §3.1)', () => {
  it('re-mints a token once less than half its lifetime remains, keeping its binding', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    const first = verifyAttachToken(tokenIn(wl), publicKeys, { now });
    now += 43_000; // just under half
    expect(await remintExpiring(deps)).toBe(0);
    now += 1_000; // past half
    expect(await remintExpiring(deps)).toBe(1);
    const second = verifyAttachToken(tokenIn(wl), publicKeys, { now });
    expect(second.exp).toBe(now + 86400);
    expect(second.exp).toBeGreaterThan(first.exp);
    expect(stsOf(wl).metadata.annotations['moca.dev/attach-exp']).toBe(String(second.exp));
    // Recorded, so the next pass leaves it.
    expect(await remintExpiring(deps)).toBe(0);
    expect({ ...second, iat: 0, exp: 0, jti: '' }).toEqual({ ...first, iat: 0, exp: 0, jti: '' });
    // Well before the old one's exp, so the worker's idle reconnect has half a day to land.
    expect(first.exp - now).toBeGreaterThan(40_000);
  });

  it('re-mints a token signed with a key this provisioner no longer holds (rotation)', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    const { privateKey: next } = generateKeyPairSync('ed25519');
    const nextSigner = makeSigner(next.export({ format: 'pem', type: 'pkcs8' }).toString());
    const nextPub = createPublicKey(next);
    const rotated = { ...deps, signer: nextSigner };
    expect(await remintExpiring(rotated)).toBe(1);
    const nextKeys = new Map([[keyIdFor(nextPub), nextPub]]);
    expect(() => verifyAttachToken(tokenIn(wl), nextKeys, { now })).not.toThrow();
  });

  it('skips a malformed or failing StatefulSet and still re-mints the ones after it', async () => {
    const bad = ref('github:alice', 'bad');
    const good = ref('github:alice', 'good');
    const badWl = workloadKeyFor(bad.owner, bad.name, bad.generation);
    const goodWl = workloadKeyFor(good.owner, good.name, good.generation);
    await putWorkload(deps, bad, { count: 1, tier: 'container' });
    await putWorkload(deps, good, { count: 1, tier: 'container' });
    const broken = (patch: (a: Record<string, string>) => void, name: string) => {
      const s = JSON.parse(JSON.stringify(stsOf(badWl)));
      s.metadata.name = name;
      patch(s.metadata.annotations);
      return s;
    };
    // Listed first: annotations a PUT never writes, and a valid one whose Secret write fails.
    const malformed = [
      broken((a) => (a['moca.dev/generation'] = 'not-a-uuid'), badWl),
      broken((a) => (a['moca.dev/record-key'] = 'sh:wl:x"}:y'), badWl),
    ];
    const list = kube.list.bind(kube);
    kube.list = async (kind, sel) => {
      const items = await list(kind, sel);
      return kind === 'statefulsets' ? [...malformed, ...items] : items;
    };
    const replace = kube.replace.bind(kube);
    kube.replace = async (kind, obj) => {
      if (obj.metadata.name === `${badWl}-attach`) throw new Error('admission denied');
      return replace(kind, obj);
    };
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(m));
    try {
      now += 50_000;
      const before = tokenIn(goodWl);
      expect(await remintExpiring(deps)).toBe(1);
      expect(tokenIn(goodWl)).not.toBe(before);
      expect(errors.some((m) => /skips .* no valid generation/.test(m))).toBe(true);
      expect(errors.some((m) => /skips .* no valid record key/.test(m))).toBe(true);
      expect(errors.some((m) => /re-mint of StatefulSet .* failed: admission denied/.test(m))).toBe(
        true,
      );
      // No token in any log line.
      expect(errors.join('\n')).not.toMatch(/eyJ/);
    } finally {
      spy.mockRestore();
    }
  });

  it('touches nothing it did not create, whatever its labels claim', async () => {
    kube.objects.secrets.set('moca-relay-attach', {
      metadata: { name: 'moca-relay-attach', labels: {} },
      data: { SH_RELAY_TOKEN: 'eA==' },
    });
    // A StatefulSet named off its workload label: never re-minted under another name.
    kube.objects.statefulsets.set('moca-sandbox', {
      metadata: {
        name: 'moca-sandbox',
        labels: {
          app: 'moca-workload-sandbox',
          'app.kubernetes.io/managed-by': 'moca-provisioner',
          'moca.dev/workload': 'moca-relay',
          'moca.dev/owner': 'x',
        },
        annotations: {
          'moca.dev/sandbox-count': '1',
          'moca.dev/generation': randomUUID(),
          'moca.dev/record-key': 'sh:wl:x:y',
          'moca.dev/tier': 'container',
        },
      },
    });
    expect(await remintExpiring(deps)).toBe(0);
    expect(kube.calls.filter((c) => /^(create|replace|patch)/.test(c))).toEqual([]);
    expect(kube.objects.secrets.get('moca-relay-attach')!.data).toEqual({ SH_RELAY_TOKEN: 'eA==' });
  });
});

describe("a mounted workload's PVC and seed (spec §5)", () => {
  const REV = 'c'.repeat(64);
  const mounted = (mount: 'read-only' | 'writable', count = 1) =>
    parseSandboxSpec(
      { count, revision: REV, mount, storage: { size: '2Gi' } },
      { ...config, storage: { maxMiB: 10 * 1024, classes: new Map() } },
    );
  const keysFor = (r: WorkloadRef) => workloadKeyFor(r.owner, r.name, r.generation);
  const ctxMounts = (c: { volumeMounts?: { name: string }[] }) =>
    (c.volumeMounts ?? []).filter((m) => m.name === 'context');

  it('checks mount, revision and the storage caps, as the worker does', () => {
    const caps = {
      ...config,
      storage: {
        maxMiB: 4096,
        classes: new Map([
          ['fast', 'rwo' as const],
          ['nfs', 'rwx' as const],
        ]),
      },
    };
    const base = { count: 1, revision: REV, mount: 'writable' };
    expect(parseSandboxSpec({ ...base, storage: { size: '1Gi' } }, caps).storage).toEqual({
      size: '1Gi',
      storageClass: 'fast',
      access: 'rwo',
    });
    expect(
      parseSandboxSpec({ ...base, storage: { size: '1Gi', storageClass: 'nfs' } }, caps).storage,
    ).toEqual({ size: '1Gi', storageClass: 'nfs', access: 'rwx' });
    for (const [body, code] of [
      [{ ...base, storage: { size: '5Gi' } }, 'workspace_size_invalid'],
      [
        { ...base, storage: { size: '1Gi', storageClass: 'standard' } },
        'storage_class_not_allowed',
      ],
      [{ ...base, mount: 'rw', storage: { size: '1Gi' } }, 'workspace_mount_invalid'],
      [{ count: 1, mount: 'writable', storage: { size: '1Gi' } }, 'workspace_mount_invalid'],
      [{ count: 1, revision: REV, storage: { size: '1Gi' } }, 'workspace_mount_invalid'],
      [
        { ...base, storage: { size: '1Gi', accessMode: 'ReadWriteOncePod' } },
        'workspace_field_not_allowed',
      ],
    ] as const) {
      expect(() => parseSandboxSpec(body, caps), code).toThrow(
        expect.objectContaining({ status: 400, code }),
      );
    }
  });

  it('creates PVC <wl> beside the StatefulSet, ReadWriteOnce, sized and labelled as it is', async () => {
    const r = ref('github:alice');
    const wl = keysFor(r);
    await putWorkload(deps, r, mounted('read-only'));
    const pvc = kube.objects.persistentvolumeclaims.get(wl)!;
    expect(pvc.spec).toEqual({
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '2Gi' } },
    });
    expect(pvc.metadata.labels).toEqual(stsOf(wl).metadata.labels);
    expect(pvc.metadata.annotations).toMatchObject({ 'moca.dev/generation': r.generation });
    // A plain claim volume, never a claim template.
    expect(stsOf(wl).spec.volumeClaimTemplates).toBeUndefined();
    expect(stsOf(wl).spec.template.spec.volumes).toContainEqual({
      name: 'context',
      persistentVolumeClaim: { claimName: wl },
    });
  });

  it('mounts read-only at revision/<rev>, seeded by one init container, with OnDelete and the seed annotation', async () => {
    const r = ref('github:alice');
    const wl = keysFor(r);
    await putWorkload(deps, r, mounted('read-only', 2));
    const sts = stsOf(wl);
    expect(sts.spec.updateStrategy).toEqual({ type: 'OnDelete' });
    expect(sts.spec.template.metadata.annotations['moca.dev/seed-revision']).toBe(REV);
    const pod = sts.spec.template.spec;
    expect(ctxMounts(pod.containers[0])).toEqual([
      {
        name: 'context',
        mountPath: '/workspace/context',
        subPath: `revision/${REV}`,
        readOnly: true,
      },
    ]);
    expect(pod.initContainers.map((c: { name: string }) => c.name)).toEqual(['seed-revision']);
    const [seed] = pod.initContainers;
    expect(ctxMounts(seed)).toEqual([
      { name: 'context', mountPath: '/seed/revision', subPath: 'revision' },
    ]);
    // MOCA's image and the template's hardening; the ordinal and annotation from the downward API.
    expect(seed.image).toBe(pod.containers[0].image);
    expect(seed.securityContext).toEqual(pod.containers[0].securityContext);
    const env = Object.fromEntries(seed.env.map((e: { name: string }) => [e.name, e]));
    expect(env.SEED_REVISION.valueFrom.fieldRef.fieldPath).toBe(
      "metadata.annotations['moca.dev/seed-revision']",
    );
    expect(env.POD_NAME.valueFrom.fieldRef.fieldPath).toBe('metadata.name');
    expect(env.SEED_URL.value).toBe(config.seedUrl);
    // ReadWriteOnce: every pod of the workload on one node.
    expect(pod.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution).toEqual([
      {
        labelSelector: { matchLabels: { 'moca.dev/workload': wl } },
        topologyKey: 'kubernetes.io/hostname',
      },
    ]);
  });

  it('a writable mount shows only moca-workspace; no container mounts the claim root or revision/ writable beside it', async () => {
    const r = ref('github:alice');
    const wl = keysFor(r);
    await putWorkload(deps, r, mounted('writable'));
    const pod = stsOf(wl).spec.template.spec;
    expect(ctxMounts(pod.containers[0])).toEqual([
      { name: 'context', mountPath: '/workspace/context', subPath: 'moca-workspace' },
    ]);
    const [rev, ws] = pod.initContainers;
    expect(ctxMounts(ws)).toEqual([
      { name: 'context', mountPath: '/seed/revision', subPath: `revision/${REV}`, readOnly: true },
      { name: 'context', mountPath: '/seed/workspace', subPath: 'moca-workspace' },
    ]);
    for (const c of [...pod.containers, rev, ws]) {
      const mounts = ctxMounts(c) as { subPath?: string; readOnly?: boolean }[];
      expect(mounts.every((m) => m.subPath)).toBe(true);
      const writable = mounts.filter((m) => !m.readOnly).map((m) => m.subPath);
      expect(writable.length).toBeLessThanOrEqual(1);
    }
  });

  it('an rwx class gets ReadWriteMany and no node affinity', async () => {
    const r = ref('github:alice');
    const wl = keysFor(r);
    const spec = parseSandboxSpec(
      { count: 2, revision: REV, mount: 'read-only', storage: { size: '1Gi' } },
      { ...config, storage: { maxMiB: 2048, classes: new Map([['nfs', 'rwx' as const]]) } },
    );
    await putWorkload(deps, r, spec);
    expect(kube.objects.persistentvolumeclaims.get(wl)!.spec).toMatchObject({
      accessModes: ['ReadWriteMany'],
      storageClassName: 'nfs',
    });
    expect(stsOf(wl).spec.template.spec.affinity).toBeUndefined();
  });

  it('a workload without a mount gets no PVC, no init container and no seed annotation', async () => {
    const r = ref('github:alice');
    const wl = keysFor(r);
    await putWorkload(deps, r, { count: 1, tier: 'container', revision: REV });
    expect(kube.objects.persistentvolumeclaims.size).toBe(0);
    const tpl = stsOf(wl).spec.template;
    expect(tpl.spec.initContainers).toBeUndefined();
    expect(tpl.metadata.annotations['moca.dev/seed-revision']).toBeUndefined();
    expect(stsOf(wl).spec.updateStrategy).toBeUndefined();
  });

  it('refuses to adopt a PVC under the derived name that is not this workload', async () => {
    const r = ref('github:alice');
    const wl = keysFor(r);
    kube.objects.persistentvolumeclaims.set(wl, { metadata: { name: wl, labels: {} } });
    await expect(putWorkload(deps, r, mounted('read-only'))).rejects.toMatchObject({
      status: 409,
      code: 'workload_object_conflict',
    });
    expect(kube.objects.statefulsets.size).toBe(0);
  });

  it('refuses to adopt a PVC that appears between its pre-read and its create', async () => {
    const r = ref('github:alice');
    const wl = keysFor(r);
    const create = kube.create.bind(kube);
    kube.create = async (kind, obj) => {
      if (kind === 'persistentvolumeclaims') {
        kube.objects.persistentvolumeclaims.set(wl, {
          metadata: { name: wl, labels: { 'moca.dev/workload': wl } },
        });
      }
      return create(kind, obj);
    };
    await expect(putWorkload(deps, r, mounted('read-only'))).rejects.toMatchObject({
      status: 409,
      code: 'workload_object_conflict',
    });
    expect(kube.objects.statefulsets.size).toBe(0);
  });

  it('holds the bundle within the seed budget across workloads: 503 seed_budget_full past it', async () => {
    deps = { ...deps, bundles: new BundleStore(100) };
    await putBundle(deps, ref('github:alice', 'one'), Buffer.alloc(45));
    await putBundle(deps, ref('github:bob', 'two'), Buffer.alloc(45));
    await expect(
      putBundle(deps, ref('github:carol', 'three'), Buffer.alloc(20)),
    ).rejects.toMatchObject({ status: 503, code: 'seed_budget_full' });
    expect(deps.bundles.heldBytes).toBe(90);
    expect(deps.bundles.reservedBytes).toBe(0);
  });

  it("holds one owner to half the budget, so one owner's stuck workloads never starve another", async () => {
    deps = { ...deps, bundles: new BundleStore(100) };
    await putBundle(deps, ref('github:alice', 'one'), Buffer.alloc(30));
    await putBundle(deps, ref('github:alice', 'two'), Buffer.alloc(20));
    // Alice's third would pass the budget's half; Bob still has his half.
    await expect(
      putBundle(deps, ref('github:alice', 'three'), Buffer.alloc(10)),
    ).rejects.toMatchObject({ status: 503, code: 'seed_budget_full' });
    expect(await putBundle(deps, ref('github:bob', 'one'), Buffer.alloc(50))).toEqual({
      held: true,
    });
  });

  it("a resend counts against the owner's share with the bundle it replaces, until that one is replaced", async () => {
    deps = { ...deps, bundles: new BundleStore(100) };
    const one = ref('github:carol', 'one');
    await putBundle(deps, one, Buffer.alloc(30));
    // 30 held and 30 more read would pass Carol's half (50): the held one stays as it was.
    await expect(putBundle(deps, one, Buffer.alloc(30))).rejects.toMatchObject({
      status: 503,
      code: 'seed_budget_full',
    });
    expect(deps.bundles.get(keysFor(one))!.bytes.length).toBe(30);
    expect(await putBundle(deps, one, Buffer.alloc(20))).toEqual({ held: true });
    expect(deps.bundles.get(keysFor(one))!.bytes.length).toBe(20);
    expect(deps.bundles.inMemory).toBe(20);
  });

  it('keeps the held bundle when a resend is refused or fails to be held', async () => {
    const r = ref('github:alice');
    const wl = keysFor(r);
    const old = Buffer.from('old bundle');
    await putBundle(deps, r, old);
    // The StatefulSet lookup fails: the resend is not held, the old one still is.
    const get = kube.get.bind(kube);
    kube.get = async () => {
      throw new Error('apiserver down');
    };
    await expect(putBundle(deps, r, Buffer.from('new bundle'))).rejects.toThrow('apiserver down');
    kube.get = get;
    expect(deps.bundles.get(wl)!.bytes).toBe(old);
    // Already seeded (no seed annotation): not held, and the old one is left to settleSeeds.
    await putWorkload(deps, r, mounted('read-only'));
    delete stsOf(wl).spec.template.metadata.annotations['moca.dev/seed-revision'];
    expect(await putBundle(deps, r, Buffer.from('new bundle'))).toEqual({ held: false });
    expect(deps.bundles.get(wl)!.bytes).toBe(old);
    expect(deps.bundles.inMemory).toBe(old.length);
  });

  it('swaps a resend in once held: the old one is released, or counted while a seed GET still sends it', async () => {
    deps = { ...deps, bundles: new BundleStore(100) };
    const r = ref('github:alice');
    const wl = keysFor(r);
    await putBundle(deps, r, Buffer.alloc(10));
    await putBundle(deps, r, Buffer.alloc(20));
    expect(deps.bundles.inMemory).toBe(20);
    const done = deps.bundles.serve(deps.bundles.get(wl)!.bytes);
    await putBundle(deps, r, Buffer.alloc(15));
    expect(deps.bundles.get(wl)!.bytes.length).toBe(15);
    expect(deps.bundles.heldBytes).toBe(15);
    expect(deps.bundles.inMemory).toBe(35);
    done();
    expect(deps.bundles.inMemory).toBe(15);
  });

  it('counts a held bundle a seed GET is sending: a resend past the budget is refused, never over it in memory', async () => {
    deps = { ...deps, bundles: new BundleStore(100) };
    await putBundle(deps, ref('github:bob'), Buffer.alloc(40));
    const r = ref('github:alice');
    await putBundle(deps, r, Buffer.alloc(25));
    const done = deps.bundles.serve(deps.bundles.get(keysFor(r))!.bytes);
    // Bob's 40, Alice's 25 being sent, and 50 more read would be 115 bytes in memory.
    await expect(putBundle(deps, r, Buffer.alloc(50))).rejects.toMatchObject({
      status: 503,
      code: 'seed_budget_full',
    });
    expect(deps.bundles.inMemory).toBe(65);
    expect(deps.bundles.get(keysFor(r))!.bytes.length).toBe(25);
    // Once replaced, the 25 still being sent counts against Alice's share: 20 + 25 + 10 > 50.
    await putBundle(deps, r, Buffer.alloc(20));
    expect(deps.bundles.inMemory).toBe(85);
    await expect(
      putBundle(deps, ref('github:alice', 'two'), Buffer.alloc(10)),
    ).rejects.toMatchObject({ status: 503, code: 'seed_budget_full' });
    done();
    expect(deps.bundles.inMemory).toBe(60);
  });

  it('drops a held bundle after MOCA_PROVISIONER_SEED_HOLD_S whether or not its StatefulSet exists, and GET then reports bundle_missing', async () => {
    deps = { ...deps, bundles: new BundleStore(1024 * 1024, 600) };
    const r = ref('github:alice');
    const wl = keysFor(r);
    const unclaimed = ref('github:alice', 'never-put');
    await putBundle(deps, r, Buffer.from('bundle'));
    await putBundle(deps, unclaimed, Buffer.from('bundle'));
    await putWorkload(deps, r, mounted('read-only'));
    // Pod 0 never initializes (a Pending claim, a crash-looping seed).
    kube.runPods(wl);
    now += 300;
    // The next activate resends it, which restarts its hold.
    await putBundle(deps, r, Buffer.from('bundle'));
    now += 301;
    expect(await settleSeeds(deps)).toEqual({ settled: 0, pending: 1 });
    expect(deps.bundles.get(wl)).toBeDefined();
    expect(deps.bundles.get(keysFor(unclaimed))).toBeUndefined();
    now += 300;
    await settleSeeds(deps);
    expect(deps.bundles.get(wl)).toBeUndefined();
    expect(deps.bundles.heldBytes).toBe(0);
    expect(await getWorkload(deps, r)).toMatchObject({ seed: 'bundle_missing' });
    // And the next activate holds it again.
    expect(await putBundle(deps, r, Buffer.from('bundle'))).toEqual({ held: true });
    expect(await getWorkload(deps, r)).toMatchObject({ seed: 'pending' });
  });

  it('settles each StatefulSet on its own: one that throws is logged, the rest and the expiry still run', async () => {
    deps = { ...deps, bundles: new BundleStore(1024 * 1024, 600) };
    const bad = ref('github:alice', 'bad');
    const good = ref('github:bob', 'good');
    const stale = ref('github:carol', 'stale');
    const old = ref('github:dave', 'old');
    for (const r of [bad, good, stale]) {
      await putBundle(deps, r, Buffer.from('bundle'));
      await putWorkload(deps, r, mounted('read-only'));
      kube.runPods(keysFor(r));
      kube.objects.pods.get(`${keysFor(r)}-0`)!.status = {
        conditions: [{ type: 'Initialized', status: 'True' }],
      };
    }
    await putBundle(deps, old, Buffer.from('bundle'));
    now += 601;
    // The stale one: listed, then deleted before its patch (a concurrent DELETE).
    const list = kube.list.bind(kube);
    kube.list = async (kind, sel) => {
      const items = await list(kind, sel);
      if (kind === 'statefulsets') kube.objects.statefulsets.delete(keysFor(stale));
      return items;
    };
    const get = kube.get.bind(kube);
    kube.get = async (kind, name) => {
      if (kind === 'pods' && name === `${keysFor(bad)}-0`) throw new Error('pods get failed');
      return get(kind, name);
    };
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(m));
    try {
      expect(await settleSeeds(deps)).toEqual({ settled: 1, pending: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(errors.some((m) => /seed check of StatefulSet .* failed: pods get failed/.test(m))).toBe(
      true,
    );
    expect(
      stsOf(keysFor(good)).spec.template.metadata.annotations['moca.dev/seed-revision'],
    ).toBeNull();
    // No patch of the deleted one, and every bundle past its hold is gone, the bad one's too.
    expect(kube.calls).not.toContain(`patch statefulsets ${keysFor(stale)}`);
    expect(deps.bundles.entries()).toEqual([]);
  });

  it('a bundle hand-off that lands after DELETE is refused, never held again', async () => {
    const r = ref('github:alice');
    await putWorkload(deps, r, mounted('read-only'));
    // The worker gave up on an activate; its hand-off is still on the wire when DELETE runs.
    const late = putBundle(deps, r, Buffer.from('bundle'));
    const del = deleteWorkload(deps, r);
    expect(await late).toEqual({ held: true });
    await del;
    expect(deps.bundles.get(keysFor(r))).toBeUndefined();
    await expect(putBundle(deps, r, Buffer.from('bundle'))).rejects.toMatchObject({
      status: 404,
      code: 'workload_not_found',
    });
    expect(deps.bundles.heldBytes).toBe(0);
    expect(deps.bundles.reservedBytes).toBe(0);
  });

  it("removes the seed annotation and drops the bundle once pod 0's init containers completed, and only then", async () => {
    const r = ref('github:alice');
    const wl = keysFor(r);
    await putBundle(deps, r, Buffer.from('bundle'));
    await putWorkload(deps, r, mounted('read-only', 2));
    expect(await getWorkload(deps, r)).toMatchObject({ seed: 'pending' });
    kube.runPods(wl);
    const initialized = { conditions: [{ type: 'Initialized', status: 'True' }] };
    // Pod 1 is not the writer: its init containers finishing says nothing about the seed.
    kube.objects.pods.get(`${wl}-1`)!.status = initialized;
    expect(await settleSeeds(deps)).toEqual({ settled: 0, pending: 1 });
    expect(deps.bundles.get(wl)).toBeDefined();
    kube.objects.pods.get(`${wl}-0`)!.status = initialized;
    expect(await settleSeeds(deps)).toEqual({ settled: 1, pending: 0 });
    expect(stsOf(wl).spec.template.metadata.annotations['moca.dev/seed-revision']).toBeNull();
    expect(deps.bundles.get(wl)).toBeUndefined();
    expect(await getWorkload(deps, r)).toMatchObject({ seed: 'done' });
    // A repeat activate after the seed holds nothing: it would never be fetched.
    expect(await putBundle(deps, r, Buffer.from('bundle'))).toEqual({ held: false });
    expect(await settleSeeds(deps)).toEqual({ settled: 0, pending: 0 });
  });

  it('reports bundle_missing when the claim is unseeded and nothing is held (a provisioner restart)', async () => {
    const r = ref('github:alice');
    await putWorkload(deps, r, mounted('writable'));
    expect(await getWorkload(deps, r)).toMatchObject({ seed: 'bundle_missing' });
    await putBundle(deps, r, Buffer.from('again'));
    expect(await getWorkload(deps, r)).toMatchObject({ seed: 'pending' });
    // An unmounted workload has no seed to report.
    const plain = ref('github:alice', 'plain');
    await putWorkload(deps, plain, { count: 1, tier: 'container' });
    expect(await getWorkload(deps, plain)).not.toHaveProperty('seed');
  });

  it('DELETE removes the PVC too, counts it until it is gone, and drops a held bundle', async () => {
    const r = ref('github:alice');
    const wl = keysFor(r);
    await putBundle(deps, r, Buffer.from('bundle'));
    await putWorkload(deps, r, mounted('read-only'));
    expect(await deleteWorkload(deps, r)).toEqual({ remaining: 1 });
    expect(kube.objects.persistentvolumeclaims.has(wl)).toBe(false);
    expect(deps.bundles.get(wl)).toBeUndefined();
    expect(await deleteWorkload(deps, r)).toEqual({ remaining: 0 });
    // A claim still held by its protection finalizer: counted, and not deleted twice.
    kube.objects.persistentvolumeclaims.set(wl, {
      metadata: {
        name: wl,
        labels: stsOf(wl)?.metadata.labels ?? {
          app: 'moca-workload-sandbox',
          'moca.dev/workload': wl,
          'moca.dev/owner': ownerScopeFor(r.owner),
          'app.kubernetes.io/managed-by': 'moca-provisioner',
        },
        deletionTimestamp: '2026-10-22T00:00:00Z',
      },
    });
    kube.calls = [];
    expect(await deleteWorkload(deps, r)).toEqual({ remaining: 1 });
    expect(kube.calls).not.toContain(`delete persistentvolumeclaims ${wl}`);
  });
});
