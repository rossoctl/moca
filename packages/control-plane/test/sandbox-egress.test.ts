import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiIssuer, HANDLERS } from '../src/handlers.js';
import { HostRegistry } from '../src/host-handlers.js';
import { buildHandler } from '../src/server.js';
import { CpError } from '../src/errors.js';
import { canonicalJson, ProvenanceStore } from '../src/provenance.js';
import { FileTemplateCatalog } from '../src/template-catalog.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
import { DEFAULT_POLICY } from '../src/template-policy.js';
import {
  EGRESS_TOTAL_BYTES,
  EGRESS_DROP_REPORT_MAX,
  EGRESS_DROP_WINDOW_S,
  EGRESS_GRACE_S,
  EGRESS_LOG_CAP,
  EVENT_FIELDS,
  MemoryEgressStore,
} from '../src/egress-log.js';
import { admin, alice, bob, codeOf, ctx, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

// Per-sandbox egress records through the API
// (docs/specs/2026-11-08-sandbox-egress-records-design.md).

const EX = resolve(__dirname, '../../../deploy/sbx/template-onboarding/examples');
const SPEC = JSON.parse(readFileSync(join(EX, 'django__django-11133.json'), 'utf8')) as Record<
  string,
  any
>; // eslint-disable-line @typescript-eslint/no-explicit-any
const { id: _id, image: IMAGE, schema: _s, notes: _n, ...REST } = SPEC;
const BASE_SPEC = { ...REST, source_record_digest: undefined, skip_git_identity_check: false };
const DIGEST = IMAGE.slice(IMAGE.indexOf('@') + 1);
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const hash = (c: string) => `sha256:${c.repeat(64)}`;

let seq = 0;
let now = NOW_MS;
const nowS = () => Math.floor(now / 1000);
const asHost = (host: string, body: unknown = {}, params: Record<string, string> = {}) =>
  ({ ...ctx({ params: { host, ...params }, body }), host }) as ReturnType<typeof ctx> & {
    host: string;
  };

async function registered(d: TestDeps, id: string, h: string, worker: string, host = 'host-1') {
  await HANDLERS.createTemplate!(
    ctx({ principal: alice, body: { id, image: IMAGE, spec: BASE_SPEC, profile: 'base' } }),
    d,
  );
  const c = (await HANDLERS.hostClaimBuilds!(asHost(host, { max: 1 }), d)).body as Body;
  const r = (
    await HANDLERS.hostBuildReport!(
      asHost(
        host,
        {
          event: 'built',
          templateRecord: JSON.stringify({
            schema: 'moca-sbx-template/1',
            id,
            worker,
            snapshot: `${id}-x`,
            image: IMAGE,
            guest_ram_mb: 4096,
            manifest_hash: h,
          }),
          manifest: JSON.stringify({
            hash_version: 2,
            hash: h,
            guest_ram_mb: 4096,
            vcpus: 2,
            source_image_digest: DIGEST,
          }),
        },
        { build: c.builds[0].build },
      ),
      d,
    )
  ).body as Body;
  expect(r.status).toBe('registered');
}

const inventory = (d: TestDeps, host: string, holds: Record<string, string>) =>
  HANDLERS.hostInventory!(
    asHost(host, {
      holds: Object.entries(holds).map(([manifestHash, template]) => ({ manifestHash, template })),
      limits: { activeLimit: 4, idleLimitSeconds: 3600 },
    }),
    d,
  );

/** Two templates: t1 on host-1 (worker sbx_t1), t2 on host-2 (worker sbx_t2), both active. */
async function setup(over: Partial<Parameters<typeof makeDeps>[0]> = {}): Promise<TestDeps> {
  now = NOW_MS;
  const dir = mkdtempSync(join(tmpdir(), 'cp-egress-'));
  const provenance = new ProvenanceStore({ dir, now: () => now });
  const d = makeDeps({
    newId: () => `${(++seq).toString(16).padStart(26, '0')}000000`,
    now: () => now,
    templates: new FileTemplateCatalog({ dir, declared: [], provenance, now: () => now }),
    provenance,
    policy: new FilePolicyStore({ dir, provenance }),
    hosts: new HostRegistry(),
    presence: {
      list: async () =>
        ['sbx_t1', 'sbx_t2'].map((w) => ({ sandboxId: w, labels: {}, capacityMax: 3 })),
    },
    config: { routeProfile: 'sandbox' },
    ...over,
  });
  await d.policy!.set(DEFAULT_POLICY, 'github:admin');
  await registered(d, 't1', hash('1'), 'sbx_t1', 'host-1');
  await registered(d, 't2', hash('2'), 'sbx_t2', 'host-2');
  await inventory(d, 'host-1', { [hash('1')]: 't1' });
  await inventory(d, 'host-2', { [hash('2')]: 't2' });
  for (const t of ['t1', 't2'])
    await HANDLERS.activateTemplate!(ctx({ principal: alice, params: { id: t }, body: {} }), d);
  return d;
}

const create = async (d: TestDeps, template = 't1', principal = alice) =>
  (await HANDLERS.createSandbox!(ctx({ principal, body: { template } }), d)).body as Body;

const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

/** An event as moca-egress writes it (audit.go Event): example.com hosts only. */
const ev = (sid: string, over: Record<string, unknown> = {}) => ({
  time: iso(nowS()),
  via: 'moca-egress',
  vm_id: 'vm-1',
  sid,
  host: 'pypi.example.com',
  dial_addr: '192.0.2.10:443',
  method: 'CONNECT',
  status: 200,
  bytes_up: 100,
  bytes_down: 2000,
  decision: 'tunnel',
  ...over,
});

let cursorN = 0;
const post = async (d: TestDeps, host: string, events: unknown[], cursor = `c${++cursorN}`) =>
  (await HANDLERS.hostEgress!(asHost(host, { events, cursor }), d)).body as Body;

const read = async (d: TestDeps, id: string, q: Record<string, string> = {}, principal = alice) =>
  HANDLERS.getSandboxEgress!(ctx({ principal, params: { id }, query: new URLSearchParams(q) }), d);

/** A streamed NDJSON body (server.ts writes it chunk by chunk), read whole. */
async function text(body: unknown): Promise<string> {
  let out = '';
  for await (const c of body as AsyncIterable<string>) out += c;
  return out;
}
const ndjsonOf = async (d: TestDeps, id: string) =>
  text((await read(d, id, { format: 'ndjson' })).body);

const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

describe('POST /v1/hosts/{host}/egress', () => {
  it("stores a sandbox's events exactly as the proxy wrote them, and refuses the rest", async () => {
    const d = await setup();
    const a = await create(d, 't1');
    const other = await create(d, 't2'); // on host-2's worker
    const e1 = ev(a.id);
    const e2 = ev(a.id, {
      method: 'GET',
      host: 'files.example.com',
      path: '/simple/x/',
      status: 403,
      decision: 'destination_denied',
      bytes_up: 0,
      bytes_down: 0,
      sub: 'github:1234',
      credential: 'pypi-mirror',
      coalesced: 2,
    });
    const r = await post(d, 'host-1', [e1, e2, ev('sbx-nobody'), ev(other.id), 'not an object']);
    expect(r).toMatchObject({ accepted: 2, refused: 3, capped: 0, invalid: 0, dropped: 0 });
    const page = (await read(d, a.id)).body as Body;
    expect(page.events).toEqual([e1, e2]);
    expect(page.next).toBeNull();
    expect(page.summary).toMatchObject({
      byHost: {
        'pypi.example.com': { count: 1, decisions: { tunnel: 1 }, bytesUp: 100, bytesDown: 2000 },
        'files.example.com': {
          count: 1,
          decisions: { destination_denied: 1 },
          bytesUp: 0,
          bytesDown: 0,
        },
      },
      total: 2,
      dropped: 0,
      complete: true,
    });
    // host-2's sandbox got nothing from host-1's post.
    expect(((await read(d, other.id)).body as Body).summary.total).toBe(0);
  });

  it('never stores a field beyond the proxy Event: such an event is not stored, and counted as dropped', async () => {
    const d = await setup();
    const a = await create(d, 't1');
    const r = await post(d, 'host-1', [
      ev(a.id, { authorization: 'Bearer x' }),
      ev(a.id, { status: '200' }),
      ev(a.id, { via: 'someone-else' }),
      ev(a.id),
    ]);
    expect(r).toMatchObject({ accepted: 1, invalid: 3 });
    const egress = d.egress as MemoryEgressStore;
    for (const e of egress.peek(a.id)!.entries) {
      for (const k of Object.keys(JSON.parse(e.line))) expect(EVENT_FIELDS).toContain(k);
    }
    expect(EVENT_FIELDS).toEqual([
      'time',
      'via',
      'vm_id',
      'sid',
      'sub',
      'host',
      'dial_addr',
      'method',
      'path',
      'credential',
      'decision',
      'status',
      'bytes_up',
      'bytes_down',
      'dropped',
      'coalesced',
    ]);
    const s = ((await read(d, a.id)).body as Body).summary;
    expect(s).toMatchObject({ total: 1, dropped: 3, droppedBy: { invalid: 3 }, complete: false });
  });

  it('maps sid by the sandbox record wsk, whatever its form', async () => {
    const d = await setup();
    const a = await create(d, 't1');
    const rec = (await d.sandboxes!.get(a.id, nowS()))!;
    // A record whose workspace key differs from its id is matched by the key, not the id.
    await d.sandboxes!.markDeleted(a.id, nowS(), 3600);
    const other = { ...rec, id: 'sbx-' + 'f'.repeat(26), wsk: 'ws-anything', deletedAt: undefined };
    await d.sandboxes!.create(other, { perSubject: 9, total: 9, retentionS: 3600 }, nowS());
    const r = await post(d, 'host-1', [ev('ws-anything'), ev(other.id)]);
    expect(r).toMatchObject({ accepted: 1, refused: 1 });
    expect(((await read(d, other.id)).body as Body).events).toEqual([ev('ws-anything')]);
  });

  it('is idempotent by (host, cursor): a retried post appends nothing', async () => {
    const d = await setup();
    const a = await create(d, 't1');
    const first = await post(d, 'host-1', [ev(a.id)], 'cur-1');
    const again = await post(d, 'host-1', [ev(a.id)], 'cur-1');
    expect(again).toEqual(first);
    expect(((await read(d, a.id)).body as Body).summary.total).toBe(1);
    await post(d, 'host-1', [ev(a.id)], 'cur-2');
    expect(((await read(d, a.id)).body as Body).summary.total).toBe(2);
  });

  it("charges an audit_dropped report to every sandbox on the host's workers live in the window", async () => {
    const d = await setup();
    const a = await create(d, 't1');
    const b2 = await create(d, 't1', bob);
    const far = await create(d, 't2'); // host-2: not charged by host-1's report
    // One deleted long before the report: outside the window, not charged.
    const old = await create(d, 't1');
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: old.id } }), d);
    now += (EGRESS_DROP_WINDOW_S + 5) * 1000;
    const drop = {
      time: iso(nowS()),
      via: 'moca-egress',
      vm_id: '',
      sid: '',
      host: '',
      method: '',
      status: 0,
      bytes_up: 0,
      bytes_down: 0,
      decision: 'audit_dropped',
      dropped: 7,
    };
    const r = await post(d, 'host-1', [drop]);
    expect(r).toMatchObject({ accepted: 0, refused: 0, dropped: 7 });
    for (const [id, p] of [
      [a.id, alice],
      [b2.id, bob],
    ] as const) {
      const s = ((await read(d, id, {}, p)).body as Body).summary;
      expect(s).toMatchObject({ total: 0, dropped: 7, droppedBy: { proxy: 7 }, complete: false });
    }
    expect(((await read(d, far.id)).body as Body).summary.complete).toBe(true);
    expect(((await read(d, old.id)).body as Body).summary.complete).toBe(true);
    // A report's count is taken up to EGRESS_DROP_REPORT_MAX: a malformed one cannot write a huge
    // count into every sandbox, nor overflow the counter.
    const huge = { ...drop, dropped: Number.MAX_SAFE_INTEGER };
    expect(await post(d, 'host-1', [huge, huge])).toMatchObject({
      dropped: 2 * EGRESS_DROP_REPORT_MAX,
    });
    expect(((await read(d, a.id)).body as Body).summary.droppedBy.proxy).toBe(
      7 + 2 * EGRESS_DROP_REPORT_MAX,
    );
  });

  it(`caps a log at ${EGRESS_LOG_CAP} events; the overflow is counted as dropped`, async () => {
    const d = await setup();
    const a = await create(d, 't1');
    const batch = Array.from({ length: 1000 }, () => ev(a.id));
    for (let i = 0; i < EGRESS_LOG_CAP / 1000; i++) await post(d, 'host-1', batch);
    const r = await post(d, 'host-1', batch.slice(0, 5));
    expect(r).toMatchObject({ accepted: 0, capped: 5 });
    const s = ((await read(d, a.id, { limit: '1' })).body as Body).summary;
    expect(s).toMatchObject({
      total: EGRESS_LOG_CAP,
      dropped: 5,
      droppedBy: { cap: 5 },
      complete: false,
    });
  });

  it('hands the agent egressSids in the wanted state: exactly the sandboxes whose events it accepts', async () => {
    const d = await setup();
    const a = await create(d, 't1');
    const b2 = await create(d, 't1', bob);
    const far = await create(d, 't2'); // host-2's worker
    const sids = async () =>
      ((await HANDLERS.hostWanted!(asHost('host-1'), d)).body as Body).egressSids as string[];
    expect(await sids()).toEqual([a.id, b2.id].sort());
    expect(await sids()).not.toContain(far.id);
    // Ended: still listed in the grace, then not; hostEgress agrees at each step.
    await HANDLERS.deleteSandbox!(ctx({ principal: bob, params: { id: b2.id } }), d);
    now += (EGRESS_GRACE_S - 1) * 1000;
    expect(await sids()).toContain(b2.id);
    expect(await post(d, 'host-1', [ev(b2.id)])).toMatchObject({ accepted: 1, refused: 0 });
    now += 2000;
    expect(await sids()).toEqual([a.id]);
    expect(await post(d, 'host-1', [ev(b2.id), ev(a.id)])).toMatchObject({
      accepted: 1,
      refused: 1,
    });
  });

  it('refuses a post with no cursor, or more than 1000 events', async () => {
    const d = await setup();
    expect(await codeOf(() => HANDLERS.hostEgress!(asHost('host-1', { events: [] }), d))).toBe(
      'invalid_request',
    );
    expect(
      await codeOf(() =>
        HANDLERS.hostEgress!(asHost('host-1', { events: Array(1001).fill({}), cursor: 'c' }), d),
      ),
    ).toBe('invalid_request');
  });
});

describe('GET /v1/sandboxes/{id}/egress', () => {
  it('is for the owner and admins only, as GET /v1/sandboxes/{id}', async () => {
    const d = await setup();
    const a = await create(d, 't1');
    await post(d, 'host-1', [ev(a.id)]);
    expect(await codeOf(() => read(d, a.id, {}, bob))).toBe('sandbox_not_found');
    expect(((await read(d, a.id, {}, admin)).body as Body).events).toHaveLength(1);
  });

  it('pages by next (the summary on the first page), and its NDJSON export hashes to its sha256', async () => {
    const d = await setup();
    const a = await create(d, 't1');
    const events = Array.from({ length: 5 }, (_, i) => ev(a.id, { bytes_up: i }));
    await post(d, 'host-1', events);
    const p1 = (await read(d, a.id, { limit: '2' })).body as Body;
    const p2 = (await read(d, a.id, { limit: '2', after: p1.next })).body as Body;
    const p3 = (await read(d, a.id, { limit: '2', after: p2.next })).body as Body;
    expect([...p1.events, ...p2.events, ...p3.events]).toEqual(events);
    expect(p3.next).toBeNull();
    // The summary comes with the first page only; a later page reads that page alone.
    expect([p2.summary, p3.summary]).toEqual([null, null]);
    const store = d.egress!;
    const page = store.page.bind(store);
    let reads = 0;
    store.page = async (...args) => (reads++, page(...args));
    await read(d, a.id, { limit: '2', after: p1.next });
    expect(reads).toBe(1);
    store.page = page;
    const nd = await read(d, a.id, { format: 'ndjson' });
    expect(nd.contentType).toBe('application/x-ndjson');
    // The digest's definition: sha256 over each event's canonical JSON, each followed by "\n".
    const want = events.map((e) => `${canonicalJson(e)}\n`).join('');
    expect(typeof nd.body).not.toBe('string'); // streamed, never built whole
    expect(await text(nd.body)).toBe(want);
    expect(p1.summary.sha256).toBe(sha(want));
    // The empty log's digest is the sha256 of no bytes.
    const empty = await create(d, 't1');
    expect(((await read(d, empty.id)).body as Body).summary.sha256).toBe(sha(''));
    expect(await codeOf(() => read(d, a.id, { limit: '0' }))).toBe('invalid_request');
    expect(await codeOf(() => read(d, a.id, { after: 'x' }))).toBe('invalid_request');
    expect(await codeOf(() => read(d, a.id, { format: 'csv' }))).toBe('invalid_request');
  });

  it('streams the NDJSON export over HTTP, a store page at a time, byte for byte the digest', async () => {
    const d = await setup();
    const a = await create(d, 't1');
    const events = Array.from({ length: 2500 }, (_, i) => ev(a.id, { bytes_up: i }));
    for (let i = 0; i < events.length; i += 1000)
      await post(d, 'host-1', events.slice(i, i + 1000));
    const server = createServer(buildHandler(d));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const token = d.signer.mint({
        sub: alice.sub,
        tenant: alice.tenant,
        roles: [],
        scope: ['api'],
        ttlSeconds: 3600,
        now: nowS(),
        iss: apiIssuer(d.config),
      });
      const res = await fetch(`${base}/v1/sandboxes/${a.id}/egress?format=ndjson`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/x-ndjson');
      expect(res.headers.get('transfer-encoding')).toBe('chunked');
      const body = await res.text();
      expect(body).toBe(events.map((e) => `${canonicalJson(e)}\n`).join(''));
      const first = (await read(d, a.id)).body as Body;
      expect(first.summary.sha256).toBe(sha(body));
      // A store that fails before the first chunk still answers its error; one that fails after it
      // cuts the body short, never a complete-looking log.
      const store = d.egress!;
      const page = store.page.bind(store);
      let calls = 0;
      const failAt = (n: number) =>
        (store.page = async (...args) => {
          if (++calls === n) throw new CpError('redis_unavailable', 'redis is not answering');
          return page(...args);
        });
      const get = () =>
        fetch(`${base}/v1/sandboxes/${a.id}/egress?format=ndjson`, {
          headers: { authorization: `Bearer ${token}` },
        });
      failAt(1);
      expect((await get()).status).toBe(503);
      calls = 0;
      failAt(2);
      const cut = await get();
      expect(cut.status).toBe(200);
      const partial = await cut.text().catch(() => null);
      expect(partial === null || partial.length < body.length).toBe(true);
      store.page = page;
    } finally {
      server.close();
    }
  });
});

describe("the sandbox's end record names its egress log", () => {
  const ends = async (d: TestDeps, id: string) =>
    (await d.provenance!.chain('template/t1')).filter(
      (r) =>
        r.kind === 'sandbox' && (r.body as Body).sandboxId === id && r.body.state !== 'created',
    );

  it('on delete: egress {events, sha256, dropped, complete}; late events in the grace, then one egress record', async () => {
    const d = await setup();
    const a = await create(d, 't1');
    await post(d, 'host-1', [ev(a.id), ev(a.id, { host: 'cdn.example.com' })]);
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: a.id } }), d);
    const nd1 = await ndjsonOf(d, a.id);
    const [end] = await ends(d, a.id);
    expect(end!.body).toMatchObject({
      state: 'terminated',
      reason: 'deleted',
      egress: {
        events: 2,
        sha256: sha(nd1),
        dropped: 0,
        droppedBy: { proxy: 0, cap: 0, budget: 0, invalid: 0 },
        complete: true,
      },
    });
    // A late event, inside the grace, is still taken.
    now += 30_000;
    expect(await post(d, 'host-1', [ev(a.id, { decision: 'aborted' })])).toMatchObject({
      accepted: 1,
    });
    const janitor = () =>
      HANDLERS.janitorSandboxes!({ ...ctx({}), janitorAuthorized: true } as never, d);
    await janitor();
    expect(await ends(d, a.id)).toHaveLength(1); // not sealed yet
    now += EGRESS_GRACE_S * 1000;
    // Past the grace: refused, then sealed by the sweep, with one record naming the final log.
    expect(await post(d, 'host-1', [ev(a.id)])).toMatchObject({ accepted: 0, refused: 1 });
    await janitor();
    await janitor();
    const after = await ends(d, a.id);
    expect(after).toHaveLength(2);
    const nd2 = await ndjsonOf(d, a.id);
    expect(after[1]).toMatchObject({
      subject: 'janitor',
      body: { state: 'egress', egress: { events: 3, sha256: sha(nd2), complete: true } },
    });
    expect(((await read(d, a.id)).body as Body).summary.sealed).toBe(true);
  });

  it('a sweep that fails before the seal leaves the log unsealed, and the next sweep records it', async () => {
    const d = await setup();
    const a = await create(d, 't1');
    await post(d, 'host-1', [ev(a.id)]);
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: a.id } }), d);
    now += 30_000;
    await post(d, 'host-1', [ev(a.id, { decision: 'aborted' })]); // late: the end record named 1
    now += EGRESS_GRACE_S * 1000;
    const prov = d.provenance!;
    const append = prov.append.bind(prov);
    let fail = 1;
    prov.append = async (r) => {
      if ((r.body as Body).state === 'egress' && fail-- > 0) throw new Error('append failed');
      return append(r);
    };
    const janitor = () =>
      HANDLERS.janitorSandboxes!({ ...ctx({}), janitorAuthorized: true } as never, d);
    await expect(janitor()).rejects.toThrow('append failed');
    expect(((await read(d, a.id)).body as Body).summary.sealed).toBe(false);
    await janitor();
    await janitor();
    const after = await ends(d, a.id);
    expect(after).toHaveLength(2);
    expect(after[1]!.body).toMatchObject({ state: 'egress', egress: { events: 2 } });
    expect(((await read(d, a.id)).body as Body).summary.sealed).toBe(true);
  });

  it('on expiry with nothing late: one end record, no egress record; a drop marks it incomplete', async () => {
    const d = await setup();
    const a = await create(d, 't1');
    await post(d, 'host-1', [
      ev(a.id),
      {
        time: iso(nowS()),
        via: 'moca-egress',
        vm_id: '',
        sid: '',
        host: '',
        method: '',
        status: 0,
        bytes_up: 0,
        bytes_down: 0,
        decision: 'audit_dropped',
        dropped: 3,
      },
    ]);
    now += 8 * 86_400_000;
    const janitor = () =>
      HANDLERS.janitorSandboxes!({ ...ctx({}), janitorAuthorized: true } as never, d);
    await janitor();
    now += EGRESS_GRACE_S * 1000;
    await janitor();
    const e = await ends(d, a.id);
    expect(e).toHaveLength(1);
    expect(e[0]!.body).toMatchObject({
      reason: 'expired',
      egress: { events: 1, dropped: 3, droppedBy: { proxy: 3, budget: 0 }, complete: false },
    });
  });

  it('a log over the total budget: the end record and the late egress record name droppedBy.budget', async () => {
    expect(EGRESS_TOTAL_BYTES).toBe(64 * 1024 * 1024);
    expect(EGRESS_LOG_CAP).toBe(10_000);
    // A budget of three events' lines (a sandbox id is 32 characters, as newId makes them here).
    const one = Buffer.byteLength(canonicalJson(ev('0'.repeat(32))));
    const d = await setup({ egress: new MemoryEgressStore({ cap: 10, budgetBytes: 3 * one }) });
    const a = await create(d, 't1');
    expect(await post(d, 'host-1', [ev(a.id), ev(a.id), ev(a.id), ev(a.id)])).toMatchObject({
      accepted: 3,
      overBudget: 1,
    });
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: a.id } }), d);
    const [end] = await ends(d, a.id);
    expect(end!.body).toMatchObject({
      egress: { events: 3, dropped: 1, droppedBy: { budget: 1 }, complete: false },
    });
    now += 30_000;
    await post(d, 'host-1', [ev(a.id)]); // late, in the grace, and still over the budget
    now += EGRESS_GRACE_S * 1000;
    await HANDLERS.janitorSandboxes!({ ...ctx({}), janitorAuthorized: true } as never, d);
    const after = await ends(d, a.id);
    expect(after[1]!.body).toMatchObject({
      state: 'egress',
      egress: { events: 3, dropped: 2, droppedBy: { budget: 2 }, complete: false },
    });
  });

  it('without an egress store, the end record is as before', async () => {
    const d = await setup({ egress: undefined });
    const a = await create(d, 't1');
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: a.id } }), d);
    const [end] = await ends(d, a.id);
    expect(end!.body).not.toHaveProperty('egress');
    expect(await post(d, 'host-1', [ev(a.id)])).toMatchObject({ accepted: 0, refused: 1 });
  });
});
