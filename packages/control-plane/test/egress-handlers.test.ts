import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCredentialBody } from '../src/credential-store.js';
import type { EgressHost } from '../src/egress-config.js';
import type { ResolvedHeaders } from '../src/egress-resolver.js';
import { HANDLERS, type CpDeps } from '../src/handlers.js';
import { buildHandler } from '../src/server.js';
import type { SandboxRecord } from '../src/sandbox-store.js';
import { ctx, codeOf, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

// The resolver seam: a test may swap what resolverFor returns; null keeps phase 1's static one.
const seam = vi.hoisted(() => ({ stub: null as null | (() => Promise<unknown>) }));
vi.mock('../src/egress-resolver.js', async (orig) => {
  const real = await orig<typeof import('../src/egress-resolver.js')>();
  return {
    ...real,
    resolverFor: (d: unknown) => (seam.stub ? seam.stub : real.resolverFor(d as never)),
  };
});

const NOW_S = Math.floor(NOW_MS / 1000);
const KVM: EgressHost = { id: 'kvm', workers: ['sbx_default'], token: 'a'.repeat(64) }; // notsecret
const KVM2: EgressHost = { id: 'kvm2', workers: ['sbx_node22'], token: 'b'.repeat(64) }; // notsecret
const sbxA = 'sbx-' + 'a'.repeat(26);
const sbxB = 'sbx-' + 'b'.repeat(26);
const terminatedA = 'sbx-' + 'c'.repeat(26);
const ALICE = 'github:1234';

const rec = (id: string, worker: string, over: Partial<SandboxRecord> = {}): SandboxRecord => ({
  id,
  owner: ALICE,
  tenant: ALICE,
  name: '',
  template: 'default',
  worker,
  wsk: id,
  labels: {},
  createdAt: NOW_S - 10,
  expiresAt: NOW_S + 1000,
  mode: 'per-exec',
  idleTimeoutS: 0,
  modeEpoch: 0,
  ...over,
});

const cred = (name: string, kind: string, hosts: string[], secret: object, binding?: unknown) =>
  parseCredentialBody(name, {
    kind,
    consumer: 'sandbox-egress',
    destination: { hosts },
    secret,
    ...(binding ? { binding } : {}),
  });

async function egressDeps(): Promise<TestDeps> {
  const base = makeDeps().config.sandbox!;
  const d = makeDeps({
    config: {
      routeProfile: 'sandbox',
      sandbox: { ...base, egress: { hosts: [KVM, KVM2], ttlSeconds: 60 } },
    },
  });
  const limits = { perSubject: 99, total: 99, retentionS: 1000 };
  await d.sandboxes!.create(rec(sbxA, 'sbx_default'), limits, NOW_S);
  await d.sandboxes!.create(rec(sbxB, 'sbx_node22', { owner: 'github:9999' }), limits, NOW_S);
  await d.sandboxes!.create(rec(terminatedA, 'sbx_default'), limits, NOW_S);
  await d.sandboxes!.markDeleted(terminatedA, NOW_S, 1000);
  const put = (c: ReturnType<typeof cred>) => d.credentials.put(ALICE, c);
  await put(
    cred('gh', 'basic', ['github.com', 'api.github.com'], {
      username: 'x-access-token',
      password: 'PAT',
    }), // notsecret
  );
  await put(cred('mcp-gh', 'bearer', ['mcp.corp/github'], { token: 'T1' })); // notsecret
  await put(
    cred('mcp-jira', 'bearer', ['mcp.corp/jira'], { token: 'T2' }, [
      { header: 'Authorization', format: 'Bearer {token}' },
      { header: 'X-Org', format: '{token}' },
    ]),
  );
  await put(cred('svc', 'bearer', ['svc.corp:8443'], { token: 'T3' })); // notsecret
  return d;
}

const call = (d: CpDeps, host: EgressHost | undefined, body: unknown) =>
  HANDLERS.lookupEgressCredential!(ctx({ egressHost: host, body }), d);

type Body = { subject: string; ttlSeconds: number; credentials: any[] };

describe('lookupEgressCredential', () => {
  let d: TestDeps;
  beforeEach(async () => {
    seam.stub = null;
    d = await egressDeps();
  });

  it('returns the rendered owner credential and audits its name only', async () => {
    const r = await call(d, KVM, { sandbox: sbxA, host: 'API.GitHub.com' });
    expect(r).toEqual({
      status: 200,
      body: {
        subject: ALICE,
        ttlSeconds: 60,
        credentials: [
          {
            name: 'gh',
            port: 443,
            pathPrefix: '/',
            expiresAt: null,
            headers: [
              {
                name: 'Authorization',
                value: 'Basic ' + Buffer.from('x-access-token:PAT').toString('base64'),
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(d.logLines)).not.toContain('PAT');
    expect(JSON.stringify([...d.streams.values()])).not.toContain('PAT');
    expect(d.logLines).toContainEqual(
      expect.objectContaining({
        decision: 'egress_credential_issued',
        subject: ALICE,
        sandboxId: sbxA,
        credential: 'gh',
        destination: 'API.GitHub.com',
        egressHost: 'kvm',
      }),
    );
  });

  it('answers sandbox_not_found for another host’s sandbox, a terminated one and an unknown id', async () => {
    for (const sandbox of [sbxB, terminatedA, 'sbx-' + 'f'.repeat(26)])
      expect(await codeOf(() => call(d, KVM, { sandbox, host: 'github.com' }))).toBe(
        'sandbox_not_found',
      );
  });

  it('answers 401 unauthorized with no resolved egress host', async () =>
    expect(await codeOf(() => call(d, undefined, { sandbox: sbxA, host: 'github.com' }))).toBe(
      'unauthorized',
    ));

  it('answers no_credential for no match, audited, and for an owner removed from the allowlist', async () => {
    expect(await codeOf(() => call(d, KVM, { sandbox: sbxA, host: 'gitlab.com' }))).toBe(
      'no_credential',
    );
    expect(d.logLines).toContainEqual(
      expect.objectContaining({
        decision: 'egress_credential_none',
        subject: ALICE,
        sandboxId: sbxA,
        destination: 'gitlab.com',
        egressHost: 'kvm',
      }),
    );
    d.config.sandbox!.allowedSubjects = [];
    expect(await codeOf(() => call(d, KVM, { sandbox: sbxA, host: 'github.com' }))).toBe(
      'no_credential',
    );
  });

  it('on combined, answers no_credential for an owner not enrolled, though login is open there', async () => {
    d.config.routeProfile = 'combined';
    expect((await call(d, KVM, { sandbox: sbxA, host: 'github.com' })).status).toBe(200);
    d.config.sandbox!.allowedSubjects = [];
    expect(await codeOf(() => call(d, KVM, { sandbox: sbxA, host: 'github.com' }))).toBe(
      'no_credential',
    );
  });

  it('returns every path-scoped credential for a gateway host, longest prefix first', async () => {
    const r = await call(d, KVM, { sandbox: sbxA, host: 'mcp.corp' });
    const c = (r.body as Body).credentials;
    expect(c.map((x) => [x.name, x.pathPrefix])).toEqual([
      ['mcp-gh', '/github'], // longer prefix first (7 > 5)
      ['mcp-jira', '/jira'],
    ]);
    expect(c[1]!.headers).toHaveLength(2);
  });

  it('audits a credential once when two of its entries match the host', async () => {
    await d.credentials.put(
      ALICE,
      cred('twice', 'bearer', ['dup.corp/a', 'dup.corp/b'], { token: 'T4' }), // notsecret
    );
    const r = await call(d, KVM, { sandbox: sbxA, host: 'dup.corp' });
    expect((r.body as Body).credentials.map((x) => x.name)).toEqual(['twice', 'twice']);
    expect(d.logLines).toContainEqual(
      expect.objectContaining({ decision: 'egress_credential_issued', credential: 'twice' }),
    );
  });

  it('carries the port', async () =>
    expect(
      ((await call(d, KVM, { sandbox: sbxA, host: 'svc.corp' })).body as Body).credentials[0]!.port,
    ).toBe(8443));

  it('sorts by port, then prefix length descending, then name', async () => {
    await d.credentials.put(ALICE, cred('zz', 'bearer', ['mcp.corp:444'], { token: 'x' })); // notsecret
    await d.credentials.put(ALICE, cred('aa', 'bearer', ['mcp.corp/jira/deep'], { token: 'x' })); // notsecret
    const r = await call(d, KVM, { sandbox: sbxA, host: 'mcp.corp' });
    expect((r.body as Body).credentials.map((x) => x.name)).toEqual([
      'aa',
      'mcp-gh',
      'mcp-jira',
      'zz',
    ]);
  });

  it('skips a stored entry that does not parse instead of failing the lookup', async () => {
    const s = (await d.credentials.get(ALICE, 'gh'))!;
    await d.credentials.put(ALICE, {
      ...s,
      descriptor: {
        ...s.descriptor,
        destination: { hosts: ['http://github.com/x', 'github.com', ''] },
      },
    });
    const r = await call(d, KVM, { sandbox: sbxA, host: 'github.com' });
    expect((r.body as Body).credentials.map((x) => x.name)).toEqual(['gh']);
  });

  it('accepts a legacy bare host and a lenient array binding', async () => {
    const s = (await d.credentials.get(ALICE, 'svc'))!;
    await d.credentials.put(ALICE, {
      ...s,
      descriptor: {
        ...s.descriptor,
        destination: { hosts: ['legacy.corp'] },
        binding: [{ header: 'Authorization', format: 'Bearer {token}' }],
      },
    });
    const r = await call(d, KVM, { sandbox: sbxA, host: 'legacy.corp' });
    expect((r.body as Body).credentials[0]!.headers).toEqual([
      { name: 'Authorization', value: 'Bearer T3' },
    ]);
  });

  it('refuses a stored binding that breaks the write-time rules with credential_unsafe', async () => {
    const s = (await d.credentials.get(ALICE, 'svc'))!;
    await d.credentials.put(ALICE, {
      ...s,
      descriptor: { ...s.descriptor, binding: { header: 'Host', format: 'x{token}' } },
    });
    expect(await codeOf(() => call(d, KVM, { sandbox: sbxA, host: 'svc.corp' }))).toBe(
      'credential_unsafe',
    );
  });

  it('refuses a secret that renders a CR/LF header value', async () => {
    const s = (await d.credentials.get(ALICE, 'svc'))!;
    await d.credentials.put(ALICE, { ...s, secret: { token: 'a\r\nX-Evil: 1' } }); // notsecret
    expect(await codeOf(() => call(d, KVM, { sandbox: sbxA, host: 'svc.corp' }))).toBe(
      'credential_unsafe',
    );
  });

  it('refuses two elements with one (port, prefix), reached only by a write race', async () => {
    await d.credentials.put(ALICE, cred('gh2', 'bearer', ['github.com'], { token: 'x' })); // notsecret
    expect(await codeOf(() => call(d, KVM, { sandbox: sbxA, host: 'github.com' }))).toBe(
      'destination_ambiguous',
    );
  });

  it('refuses a duplicate (port, prefix) even when a same-length prefix sorts between them', async () => {
    await d.credentials.put(ALICE, cred('a', 'bearer', ['dup.corp/aa'], { token: 'x' })); // notsecret
    await d.credentials.put(ALICE, cred('b', 'bearer', ['dup.corp/bb'], { token: 'x' })); // notsecret
    await d.credentials.put(ALICE, cred('c', 'bearer', ['dup.corp/aa'], { token: 'x' })); // notsecret
    expect(await codeOf(() => call(d, KVM, { sandbox: sbxA, host: 'dup.corp' }))).toBe(
      'destination_ambiguous',
    );
  });

  it('drops a credential deleted between list and get, keeping the survivor', async () => {
    await d.credentials.put(ALICE, cred('gone', 'bearer', ['race.corp/x'], { token: 'x' })); // notsecret
    await d.credentials.put(ALICE, cred('kept', 'bearer', ['race.corp/y'], { token: 'y' })); // notsecret
    const real = d.credentials.get.bind(d.credentials);
    vi.spyOn(d.credentials, 'get').mockImplementation(async (o, n) =>
      n === 'gone' ? null : real(o, n),
    );
    const r = await call(d, KVM, { sandbox: sbxA, host: 'race.corp' });
    expect((r.body as Body).credentials.map((x) => x.name)).toEqual(['kept']);
  });

  it('answers no_credential, audited, when the only credential vanishes mid-flight', async () => {
    await d.credentials.put(ALICE, cred('gone', 'bearer', ['race.corp'], { token: 'x' })); // notsecret
    vi.spyOn(d.credentials, 'get').mockResolvedValue(null);
    expect(await codeOf(() => call(d, KVM, { sandbox: sbxA, host: 'race.corp' }))).toBe(
      'no_credential',
    );
    expect(d.logLines).toContainEqual(
      expect.objectContaining({ decision: 'egress_credential_none', destination: 'race.corp' }),
    );
  });

  it('decrypts a credential once when two of its entries match the host', async () => {
    await d.credentials.put(
      ALICE,
      cred('two', 'bearer', ['twice.corp/a', 'twice.corp/b'], { token: 'x' }), // notsecret
    );
    const spy = vi.spyOn(d.credentials, 'get');
    const r = await call(d, KVM, { sandbox: sbxA, host: 'twice.corp' });
    expect((r.body as Body).credentials).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('caps ttlSeconds at the earliest expiresAt (resolver seam)', async () => {
    seam.stub = async (): Promise<ResolvedHeaders> => ({
      headers: [{ name: 'Authorization', value: 'Bearer z' }],
      expiresAt: NOW_S + 20,
    });
    const r = await call(d, KVM, { sandbox: sbxA, host: 'github.com' });
    const b = r.body as Body;
    expect(b.ttlSeconds).toBe(20);
    expect(b.credentials[0]!.expiresAt).toBe(new Date((NOW_S + 20) * 1000).toISOString());
  });

  it('floors ttlSeconds at 5 when the earliest expiry is nearer', async () => {
    seam.stub = async (): Promise<ResolvedHeaders> => ({
      headers: [{ name: 'Authorization', value: 'Bearer z' }],
      expiresAt: NOW_S + 2,
    });
    const r = await call(d, KVM, { sandbox: sbxA, host: 'github.com' });
    expect((r.body as Body).ttlSeconds).toBe(5);
  });

  it('staticResolver returns expiresAt null', async () => {
    const { staticResolver } = await vi.importActual<typeof import('../src/egress-resolver.js')>(
      '../src/egress-resolver.js',
    );
    const s = (await d.credentials.get(ALICE, 'svc'))!;
    const out = await staticResolver(ALICE, s.descriptor, d);
    expect(out!.expiresAt).toBeNull();
    expect(out!.headers).toEqual([{ name: 'Authorization', value: 'Bearer T3' }]);
  });

  it('refuses a bad sandbox id or host before touching the store', async () => {
    const spy = vi.spyOn(d.sandboxes!, 'get');
    const bads = [
      { sandbox: 'nope', host: 'github.com' },
      { sandbox: sbxA, host: 'git hub.com' },
      { sandbox: sbxA, host: '' },
      { sandbox: sbxA, host: 'a'.repeat(254) },
      { sandbox: sbxA },
      { host: 'github.com' },
      { sandbox: 5, host: 'github.com' },
    ];
    for (const b of bads) expect(await codeOf(() => call(d, KVM, b))).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('POST /v1/egress/credential through the router', () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));
  seamReset();

  async function serve(d: TestDeps): Promise<string> {
    const server = createServer(buildHandler(d));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const post = (base: string, token: string | undefined, sandbox = sbxA) =>
    fetch(base + '/v1/egress/credential', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ sandbox, host: 'github.com' }),
    });

  it('admits each host token, and only its own sandboxes', async () => {
    const d = await egressDeps();
    d.config.sandbox!.janitorToken = 'j'.repeat(40); // notsecret
    const base = await serve(d);
    const ok = await post(base, KVM.token);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Body).subject).toBe(ALICE);
    const other = await post(base, KVM2.token);
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ error: 'sandbox_not_found' });
    // KVM2's own sandbox, but its owner is not enrolled: no_credential, not sandbox_not_found.
    const own = await post(base, KVM2.token, sbxB);
    expect(own.status).toBe(404);
    expect(await own.json()).toMatchObject({ error: 'no_credential' });
  });

  it('answers 401 unauthorized to no bearer, a wrong bearer, a user API token and the janitor token', async () => {
    const d = await egressDeps();
    d.config.sandbox!.janitorToken = 'j'.repeat(40); // notsecret
    const user = d.signer.mint({
      sub: ALICE,
      tenant: ALICE,
      roles: ['admin'],
      scope: ['api'],
      ttlSeconds: 3600,
      now: NOW_S,
    });
    const base = await serve(d);
    for (const t of [undefined, 'c'.repeat(64), user, 'j'.repeat(40)]) {
      const res = await post(base, t);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    }
  });

  it('is unmounted without egress config', async () => {
    const d = makeDeps({ config: { routeProfile: 'sandbox' } });
    expect((await post(await serve(d), KVM.token)).status).toBe(404);
  });
});

function seamReset() {
  beforeEach(() => {
    seam.stub = null;
  });
}
