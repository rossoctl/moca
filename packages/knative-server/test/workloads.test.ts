import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';
import { startServer } from '../src/server.js';

// The workload lifecycle against a real Redis (its Lua compare-and-set is the point) and a fake
// Context Service that implements the trusted API's observable rules.

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const REVISION = 'a'.repeat(64);
const OTHER_REVISION = 'b'.repeat(64);

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const apiToken = (sub: string) =>
  signer.mint({ sub, tenant: sub, roles: [], scope: ['api'], ttlSeconds: 300 });

interface FakeContext {
  contextId: string;
  owner: string;
  type: string;
  storage: Record<string, unknown>;
  currentRevision?: string;
  frozenRevision?: string;
}

/** Context Service, reduced to what Moca can observe. */
class FakeContextService {
  contexts = new Map<string, FakeContext>();
  calls: { method: string; path: string; subject: string; auth: string }[] = [];
  /**
   * One-shot: the next request to this operation waits until the returned release is called, either
   * before Context Service acts on it or after it has acted but before it answers.
   */
  private holds = new Map<string, { when: 'before' | 'after'; released: Promise<void> }>();
  /** One-shot: the next request to this operation fails with this status. */
  failures = new Map<string, number>();
  server = http.createServer((req, res) => void this.handle(req, res));

  hold(operation: string, when: 'before' | 'after' = 'before'): () => void {
    let release!: () => void;
    this.holds.set(operation, { when, released: new Promise<void>((r) => (release = r)) });
    return release;
  }

  ownedBy(owner: string): [string, FakeContext][] {
    return [...this.contexts].filter(([, context]) => context.owner === `user:${owner}`);
  }

  /** What a client's PUT to its grant does: publish a current revision. */
  upload(owner: string, revision = REVISION): void {
    const [entry] = this.ownedBy(owner);
    entry![1].currentRevision = revision;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const path = req.url ?? '';
    const subject = String(req.headers['x-context-subject'] ?? '');
    this.calls.push({
      method: req.method ?? '',
      path,
      subject,
      auth: String(req.headers.authorization),
    });
    const match = /^\/(?:internal\/)?v1\/namespaces\/moca\/contexts\/([^/]+)(\/[a-z-]+)?$/.exec(
      path,
    );
    const operation =
      path === '/internal/v1/contexts'
        ? 'create'
        : match?.[2] === '/upload-capabilities'
          ? 'grant'
          : match?.[2] === '/freeze'
            ? 'freeze'
            : req.method === 'DELETE'
              ? 'delete'
              : 'unknown';
    const held = this.holds.get(operation);
    if (held) this.holds.delete(operation);
    if (held?.when === 'before') await held.released;
    const send = async (status: number, value?: unknown) => {
      if (held?.when === 'after') await held.released;
      if (value === undefined) res.writeHead(status).end();
      else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    };
    const failure = this.failures.get(operation);
    if (failure) {
      this.failures.delete(operation);
      return send(failure, { error: 'internal_error' });
    }
    const view = (name: string, context: FakeContext) => ({
      contextId: context.contextId,
      name,
      namespace: 'moca',
      type: context.type,
      status: 'ready',
      ...(context.currentRevision ? { currentRevision: context.currentRevision } : {}),
      ...(context.frozenRevision ? { frozenRevision: context.frozenRevision } : {}),
    });
    if (operation === 'create') {
      if (this.contexts.has(body.name)) return send(409, { error: 'already_exists' });
      const context = {
        contextId: randomUUID(),
        owner: subject,
        type: body.type,
        storage: body.storage,
      };
      this.contexts.set(body.name, context);
      return send(201, view(body.name, context));
    }
    const name = decodeURIComponent(match?.[1] ?? '');
    const context = this.contexts.get(name);
    if (!context || context.owner !== subject) return send(404, { error: 'not_found' });
    if (operation === 'delete') {
      this.contexts.delete(name);
      return send(204);
    }
    if (operation === 'grant') {
      if (context.frozenRevision) return send(409, { error: 'context_frozen' });
      return send(201, {
        uploadUrl: `/v1/uploads/${randomUUID().replaceAll('-', '')}`,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        method: 'PUT',
        contentType: 'application/vnd.rossoctl.context',
        maxBytes: 268435456,
      });
    }
    if (operation === 'freeze') {
      if (context.currentRevision !== body.revision)
        return send(409, { error: 'revision_mismatch' });
      context.frozenRevision = body.revision;
      return send(200, view(name, context));
    }
    send(404, { error: 'not_found' });
  }
}

const redis = createClient({ url: REDIS_URL });
const quotaOf = async (owner: string) =>
  Number(
    (await redis.get(
      `sh:workload-quota:${createHash('sha256').update(owner).digest('hex').slice(0, 32)}`,
    )) ?? '0',
  );

let cs: FakeContextService;
let server: ReturnType<typeof startServer>;
let base: string;
let alice: string;
let bob: string;

beforeAll(async () => {
  await redis.connect();
});
afterAll(async () => {
  await redis.close();
});

beforeEach(async () => {
  // Fresh subjects per test keep every Redis key unique without flushing the database.
  alice = `github:alice-${randomUUID()}`;
  bob = `github:bob-${randomUUID()}`;
  cs = new FakeContextService();
  await new Promise<void>((resolve) => cs.server.listen(0, '127.0.0.1', resolve));
  const csUrl = `http://127.0.0.1:${(cs.server.address() as { port: number }).port}`;
  for (const [key, value] of Object.entries({
    MOCA_CONTEXT_WORKLOADS_ENABLED: '1',
    CONTEXT_SERVICE_URL: csUrl,
    CONTEXT_SERVICE_PUBLIC_URL: 'https://cs.example/context/',
    CONTEXT_SERVICE_TOKEN: 'cs-service-token', // notsecret
    CONTEXT_SERVICE_NAMESPACE: 'moca',
    MOCA_CONTEXT_STORAGE_CLASSES: 'fast, scale',
    SH_SESSION_TOKEN_PUBLIC_KEYS: `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`,
    REDIS_URL,
  }))
    vi.stubEnv(key, value);
  server = startServer(0);
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => cs.server.close(() => resolve()));
});

async function call(method: string, path: string, owner?: string | null, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(owner ? { authorization: `Bearer ${apiToken(owner)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const create = (owner: string, name: string, extra: Record<string, unknown> = {}) =>
  call('POST', '/workloads', owner, { name, ...extra });

describe('workload authentication', () => {
  it('refuses an anonymous caller even when SH_REQUIRE_AUTH is off', async () => {
    vi.stubEnv('SH_REQUIRE_AUTH', 'false');
    expect(await call('POST', '/workloads', null, { name: 'demo' })).toMatchObject({
      status: 401,
      body: { error: 'token_required' },
    });
    expect((await call('GET', '/workloads/demo')).status).toBe(401);
    expect(cs.calls).toEqual([]);
  });

  it('refuses a session token: workloads take the API token', async () => {
    const session = signer.mint({
      sub: alice,
      tenant: alice,
      roles: [],
      scope: ['turn:write'],
      sid: 's-1',
      ttlSeconds: 300,
    });
    const response = await fetch(`${base}/workloads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session}` },
      body: JSON.stringify({ name: 'demo' }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'token_invalid' });
  });

  it('answers 500 and calls nothing when the upload URL would be plain HTTP off loopback', async () => {
    vi.stubEnv('CONTEXT_SERVICE_PUBLIC_URL', 'http://cs.example');
    expect(await create(alice, 'demo')).toEqual({
      status: 500,
      body: { error: 'workloads_misconfigured' },
    });
    expect(cs.calls).toEqual([]);
    expect(await quotaOf(alice)).toBe(0);
  });
});

describe('workload lifecycle', () => {
  it('creates, renews the grant, activates, and deletes', async () => {
    const created = await create(alice, 'demo', {
      workspace: { size: '2Gi', storageClass: 'fast' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      workloadId: 'demo',
      status: 'awaiting_upload',
      contextType: 'workspace',
      workspace: { size: '2Gi', storageClass: 'fast' },
      upload: {
        uploadUrl: expect.stringMatching(
          /^https:\/\/cs\.example\/context\/v1\/uploads\/[0-9a-f]+$/,
        ),
        token: expect.any(String),
        expiresAt: expect.any(String),
        method: 'PUT',
        contentType: 'application/vnd.rossoctl.context',
        maxBytes: 268435456,
      },
    });
    // Context Service saw the user as the subject and the service bearer, and got a derived name.
    const [[contextName, context]] = cs.ownedBy(alice);
    expect(contextName).toMatch(/^w-[0-9a-f]{32}$/);
    expect(context!.storage).toEqual({
      backend: 'pvc',
      accessMode: 'ReadWriteOnce',
      size: '2Gi',
      storageClass: 'fast',
    });
    expect(cs.calls[0]).toMatchObject({
      subject: `user:${alice}`,
      auth: 'Bearer cs-service-token',
    });
    // Neither the Context's name nor its identity is ever returned.
    expect(JSON.stringify(created.body)).not.toContain(contextName!);
    expect(JSON.stringify(created.body)).not.toContain(context!.contextId);

    expect(await call('POST', '/workloads/demo/uploads', alice)).toMatchObject({
      status: 201,
      body: { method: 'PUT', uploadUrl: expect.stringMatching(/^https:\/\/cs\.example\//) },
    });
    // Nothing uploaded yet: Context Service refuses to freeze, and its code passes through.
    expect(await call('POST', '/workloads/demo/activate', alice, { revision: REVISION })).toEqual({
      status: 409,
      body: { error: 'revision_mismatch' },
    });

    cs.upload(alice);
    const ready = await call('POST', '/workloads/demo/activate', alice, { revision: REVISION });
    expect(ready).toEqual({
      status: 200,
      body: {
        workloadId: 'demo',
        status: 'ready',
        contextType: 'workspace',
        workspace: { size: '2Gi', storageClass: 'fast' },
        revision: REVISION,
      },
    });
    // Repeating it is harmless; a different revision is not.
    expect(
      (await call('POST', '/workloads/demo/activate', alice, { revision: REVISION })).status,
    ).toBe(200);
    expect(
      await call('POST', '/workloads/demo/activate', alice, { revision: OTHER_REVISION }),
    ).toEqual({ status: 409, body: { error: 'workload_already_active' } });
    expect(await call('POST', '/workloads/demo/uploads', alice)).toEqual({
      status: 409,
      body: { error: 'workload_not_awaiting_upload' },
    });
    expect((await call('GET', '/workloads/demo', alice)).body).toMatchObject({ status: 'ready' });

    expect(await call('DELETE', '/workloads/demo', alice)).toEqual({ status: 204, body: null });
    expect(cs.contexts.size).toBe(0);
    expect((await call('GET', '/workloads/demo', alice)).body).toMatchObject({ status: 'deleted' });
    expect(await call('DELETE', '/workloads/demo', alice)).toEqual({
      status: 404,
      body: { error: 'workload_not_found' },
    });
    expect(await quotaOf(alice)).toBe(0);
  });

  it('expires a deleted record, and only a deleted one', async () => {
    vi.stubEnv('MOCA_WORKLOAD_DELETED_TTL_SECONDS', '120');
    await create(alice, 'expiring');
    const key = `sh:workload:${createHash('sha256').update(alice).digest('hex').slice(0, 32)}:expiring`;
    expect(await redis.ttl(key)).toBe(-1);
    expect((await call('DELETE', '/workloads/expiring', alice)).status).toBe(204);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('re-creates a name after delete with a new Context', async () => {
    await create(alice, 'again');
    const [[first]] = cs.ownedBy(alice);
    expect((await call('DELETE', '/workloads/again', alice)).status).toBe(204);
    expect((await create(alice, 'again')).status).toBe(201);
    const [[second]] = cs.ownedBy(alice);
    expect(second).not.toBe(first);
    expect(await quotaOf(alice)).toBe(1);
  });

  it('validates the request', async () => {
    const cases: [unknown, string][] = [
      [{ name: 'Bad_Name' }, 'workload_name_invalid'],
      [{ name: 'x'.repeat(51) }, 'workload_name_invalid'],
      [{ name: 'ok', contextUpload: true }, 'workload_field_not_allowed'],
      [{ name: 'ok', contextType: 'secrets' }, 'context_type_invalid'],
      [{ name: 'ok', workspace: { claimName: 'pvc' } }, 'workspace_field_not_allowed'],
      [{ name: 'ok', workspace: { size: '11Gi' } }, 'workspace_size_invalid'],
      [{ name: 'ok', workspace: { size: '1Ti' } }, 'workspace_size_invalid'],
      [{ name: 'ok', workspace: { storageClass: 'other' } }, 'storage_class_not_allowed'],
      [[], 'workload_invalid'],
    ];
    for (const [body, error] of cases) {
      expect(await call('POST', '/workloads', alice, body)).toEqual({
        status: 400,
        body: { error },
      });
    }
    expect(
      await call('POST', '/workloads/missing/activate', alice, { revision: 'not-a-digest' }),
    ).toEqual({ status: 400, body: { error: 'revision_invalid' } });
    expect((await call('PUT', '/workloads/demo', alice, {})).status).toBe(405);
    expect(cs.calls).toEqual([]);
  });
});

describe('names are scoped per owner', () => {
  it('lets two users each own the same name, each with their own Context', async () => {
    expect((await create(alice, 'demo')).status).toBe(201);
    expect((await create(bob, 'demo')).status).toBe(201);
    const [[aliceContext]] = cs.ownedBy(alice);
    const [[bobContext]] = cs.ownedBy(bob);
    expect(aliceContext).not.toBe(bobContext);
    cs.upload(bob);
    expect(
      (await call('POST', '/workloads/demo/activate', bob, { revision: REVISION })).status,
    ).toBe(200);
    expect((await call('GET', '/workloads/demo', alice)).body).toMatchObject({
      status: 'awaiting_upload',
    });
  });

  it("answers 409 only for the owner's own live name", async () => {
    await create(alice, 'demo');
    expect(await create(alice, 'demo')).toEqual({
      status: 409,
      body: { error: 'workload_name_taken' },
    });
  });

  it("makes another user's workload indistinguishable from a missing one", async () => {
    await create(alice, 'mine');
    const notFound = { status: 404, body: { error: 'workload_not_found' } };
    for (const name of ['mine', 'never-created']) {
      expect(await call('GET', `/workloads/${name}`, bob)).toEqual(notFound);
      expect(await call('POST', `/workloads/${name}/uploads`, bob)).toEqual(notFound);
      expect(
        await call('POST', `/workloads/${name}/activate`, bob, { revision: REVISION }),
      ).toEqual(notFound);
      expect(await call('DELETE', `/workloads/${name}`, bob)).toEqual(notFound);
    }
    expect(cs.contexts.size).toBe(1);
    expect(cs.calls.filter((c) => c.subject === `user:${bob}`)).toEqual([]);
  });
});

describe('quota', () => {
  it('limits live workloads per owner and frees a unit on delete', async () => {
    vi.stubEnv('MOCA_CONTEXT_MAX_WORKLOADS_PER_OWNER', '1');
    expect((await create(alice, 'one')).status).toBe(201);
    expect(await create(alice, 'two')).toEqual({
      status: 429,
      body: { error: 'workload_quota_exceeded' },
    });
    expect((await create(bob, 'one')).status).toBe(201);
    expect((await call('DELETE', '/workloads/one', alice)).status).toBe(204);
    expect((await create(alice, 'two')).status).toBe(201);
  });

  it('releases the unit exactly once and rolls back the Context when create fails', async () => {
    await create(alice, 'keep');
    cs.failures.set('grant', 500);
    expect(await create(alice, 'fail')).toEqual({
      status: 502,
      body: { error: 'context_service_error' },
    });
    expect(cs.ownedBy(alice)).toHaveLength(1);
    expect(await quotaOf(alice)).toBe(1);
    expect((await call('GET', '/workloads/fail', alice)).body).toMatchObject({ status: 'deleted' });
    expect((await create(alice, 'fail')).status).toBe(201);
    expect(await quotaOf(alice)).toBe(2);
  });

  it('keeps a failed delete retryable, with its quota unit, until it succeeds', async () => {
    await create(alice, 'demo');
    cs.failures.set('delete', 500);
    expect(await call('DELETE', '/workloads/demo', alice)).toEqual({
      status: 502,
      body: { error: 'context_service_error' },
    });
    expect((await call('GET', '/workloads/demo', alice)).body).toMatchObject({
      status: 'deleting',
    });
    expect(await quotaOf(alice)).toBe(1);
    expect((await call('DELETE', '/workloads/demo', alice)).status).toBe(204);
    expect(await quotaOf(alice)).toBe(0);
    expect(cs.contexts.size).toBe(0);
  });
});

describe('lifecycle races', () => {
  it('a delete during create wins; the late Context is rolled back and quota released once', async () => {
    await create(alice, 'keep');
    const release = cs.hold('create');
    const creating = create(alice, 'early');
    await vi.waitFor(() =>
      expect(cs.calls.some((c) => c.path === '/internal/v1/contexts')).toBe(true),
    );
    expect((await call('DELETE', '/workloads/early', alice)).status).toBe(204);
    release();
    expect(await creating).toEqual({ status: 409, body: { error: 'workload_state_changed' } });
    expect(cs.ownedBy(alice)).toHaveLength(1);
    expect(await quotaOf(alice)).toBe(1);
    expect((await call('GET', '/workloads/early', alice)).body).toMatchObject({
      status: 'deleted',
    });
  });

  it('a stale create does not roll back the Context of a newer re-creation', async () => {
    const release = cs.hold('create');
    const stale = create(alice, 'reused');
    await vi.waitFor(() => expect(cs.calls.length).toBe(1));
    expect((await call('DELETE', '/workloads/reused', alice)).status).toBe(204);
    expect((await create(alice, 'reused')).status).toBe(201);
    const [[newer]] = cs.ownedBy(alice);
    release();
    expect((await stale).status).toBe(409);
    expect(cs.ownedBy(alice).map(([name]) => name)).toEqual([newer]);
    expect((await call('GET', '/workloads/reused', alice)).body).toMatchObject({
      status: 'awaiting_upload',
    });
    expect((await call('POST', '/workloads/reused/uploads', alice)).status).toBe(201);
    expect(await quotaOf(alice)).toBe(1);
  });

  it('an activate racing a delete cannot resurrect the workload', async () => {
    await create(alice, 'race');
    cs.upload(alice);
    // Context Service freezes, then the delete lands before Moca records the activation.
    const release = cs.hold('freeze', 'after');
    const activating = call('POST', '/workloads/race/activate', alice, { revision: REVISION });
    await vi.waitFor(() => expect(cs.calls.some((c) => c.path.endsWith('/freeze'))).toBe(true));
    expect((await call('DELETE', '/workloads/race', alice)).status).toBe(204);
    release();
    expect(await activating).toEqual({ status: 409, body: { error: 'workload_state_changed' } });
    expect((await call('GET', '/workloads/race', alice)).body).toMatchObject({ status: 'deleted' });
    expect(await quotaOf(alice)).toBe(0);
  });
});
