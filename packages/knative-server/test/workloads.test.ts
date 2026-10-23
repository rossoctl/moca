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
/** One token per caller, so a test can check the exact token the worker forwarded. */
const tokens = new Map<string, string>();
const tokenOf = (sub: string) => tokens.get(sub) ?? tokens.set(sub, apiToken(sub)).get(sub)!;

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
  /**
   * The next N requests to this operation drop the socket before responding, so the harness sees
   * them as unreachable (fetch rejection, no HTTP status). The counter decrements per hit.
   */
  unreachable = new Map<string, number>();
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
    const remaining = this.unreachable.get(operation) ?? 0;
    if (remaining > 0) {
      if (remaining === 1) this.unreachable.delete(operation);
      else this.unreachable.set(operation, remaining - 1);
      req.socket.destroy();
      return;
    }
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
      `sh:wl-quota:${createHash('sha256').update(owner).digest('hex').slice(0, 32)}`,
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
      ...(owner ? { authorization: `Bearer ${tokenOf(owner)}` } : {}),
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
    expect(await call('GET', '/workloads/demo')).toMatchObject({
      status: 401,
      body: { error: 'token_required' },
    });
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
    const key = `sh:wl:${createHash('sha256').update(alice).digest('hex').slice(0, 32)}:expiring`;
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

  it('treats a body-less create as all defaults', async () => {
    const response = await fetch(base + '/workloads', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken(alice)}` },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      workloadId: expect.stringMatching(/^wl-/),
      status: 'awaiting_upload',
    });
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
    expect(await call('PUT', '/workloads/demo', alice, {})).toEqual({
      status: 405,
      body: { error: 'method_not_allowed' },
    });
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

  // A transient Context Service unreachability during the rollback's deleteContext would
  // otherwise leave the record in `deleting` with its quota slot held, invisibly to the owner.
  // The retry inside rollbackCreate absorbs the blip and lets the record reach `deleted`.
  it('absorbs a transient Context Service blip during rollback and frees the quota', async () => {
    vi.stubEnv('MOCA_CONTEXT_ROLLBACK_RETRY_ATTEMPTS', '3');
    vi.stubEnv('MOCA_CONTEXT_ROLLBACK_RETRY_BACKOFF_MS', '10');
    cs.failures.set('grant', 500); // force the create to fail → rollback runs
    cs.unreachable.set('delete', 2); // first two rollback-delete attempts are unreachable
    expect(await create(alice, 'blip')).toEqual({
      status: 502,
      body: { error: 'context_service_error' },
    });
    // The third rollback-delete got through: record is deleted, quota released.
    expect((await call('GET', '/workloads/blip', alice)).body).toMatchObject({ status: 'deleted' });
    expect(await quotaOf(alice)).toBe(0);
    expect(cs.ownedBy(alice)).toHaveLength(0);
    // Pin the budget: exactly 3 rollback-delete attempts (ATTEMPTS=3). An off-by-one in the loop
    // or a regression to "attempts + 1" would fail here.
    expect(cs.calls.filter((c) => c.method === 'DELETE').length).toBe(3);
  });

  // A sustained Context Service outage must not paper over the failure. The record stays
  // `deleting` so the owner-driven DELETE still finishes the cleanup once Context Service is back.
  it('leaves the record deleting when the Context Service stays unreachable past the retry budget', async () => {
    vi.stubEnv('MOCA_CONTEXT_ROLLBACK_RETRY_ATTEMPTS', '3');
    vi.stubEnv('MOCA_CONTEXT_ROLLBACK_RETRY_BACKOFF_MS', '10');
    cs.failures.set('grant', 500);
    cs.unreachable.set('delete', 10); // more unreachables than retries: outage outlasts the budget
    expect(await create(alice, 'stuck')).toEqual({
      status: 502,
      body: { error: 'context_service_error' },
    });
    expect((await call('GET', '/workloads/stuck', alice)).body).toMatchObject({
      status: 'deleting',
    });
    expect(await quotaOf(alice)).toBe(1);
    // Pin the budget: exactly 3 rollback-delete attempts, no more.
    expect(cs.calls.filter((c) => c.method === 'DELETE').length).toBe(3);
    // Context Service recovers (unreachable counter still positive but we clear it); owner's
    // DELETE finishes the pending cleanup and frees the quota.
    cs.unreachable.delete('delete');
    expect((await call('DELETE', '/workloads/stuck', alice)).status).toBe(204);
    expect(await quotaOf(alice)).toBe(0);
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
    expect(await stale).toEqual({ status: 409, body: { error: 'workload_state_changed' } });
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

  it('a GET in the delete window reports deleting, writes nothing, and cannot resurrect it', async () => {
    await create(alice, 'observed');
    const key = `sh:wl:${createHash('sha256').update(alice).digest('hex').slice(0, 32)}:observed`;
    // The delete is held at Context Service, so the record is already `deleting` while it waits.
    const release = cs.hold('delete');
    const deleting = call('DELETE', '/workloads/observed', alice);
    await vi.waitFor(() => expect(cs.calls.some((c) => c.method === 'DELETE')).toBe(true));
    const raw = await redis.get(key);
    expect(await call('GET', '/workloads/observed', alice)).toMatchObject({
      status: 200,
      body: { status: 'deleting' },
    });
    // A GET in the delete's window leaves the stored record byte-identical (#363's write-back race).
    expect(await redis.get(key)).toBe(raw);
    release();
    expect(await deleting).toEqual({ status: 204, body: null });
    expect((await call('GET', '/workloads/observed', alice)).body).toMatchObject({
      status: 'deleted',
    });
    // A deleted workload cannot return to an active state.
    expect(
      await call('POST', '/workloads/observed/activate', alice, { revision: REVISION }),
    ).toEqual({ status: 404, body: { error: 'workload_not_found' } });
    expect(await call('POST', '/workloads/observed/uploads', alice)).toEqual({
      status: 404,
      body: { error: 'workload_not_found' },
    });
    expect(cs.contexts.size).toBe(0);
    expect(await quotaOf(alice)).toBe(0);
  });

  it('two deletes racing converge on one deleted record and one quota release', async () => {
    await create(alice, 'twice');
    // The first delete is held at Context Service, the record already `deleting`.
    const release = cs.hold('delete');
    const first = call('DELETE', '/workloads/twice', alice);
    await vi.waitFor(() => expect(cs.calls.some((c) => c.method === 'DELETE')).toBe(true));
    // The second reads the `deleting` record and finishes the same delete.
    const second = await call('DELETE', '/workloads/twice', alice);
    release();
    expect(second).toEqual({ status: 204, body: null });
    expect(await first).toEqual({ status: 204, body: null });
    expect((await call('GET', '/workloads/twice', alice)).body).toMatchObject({
      status: 'deleted',
    });
    expect(cs.contexts.size).toBe(0);
    expect(await quotaOf(alice)).toBe(0);
  });
});

/** moca-provisioner, reduced to what the worker observes: both credentials, and its answers. */
class FakeProvisioner {
  calls: { method: string; path: string; auth: string; user: string; body: unknown }[] = [];
  /** Pods every DELETE reports as still terminating. */
  podsLeft = 0;
  /** One-shot: the next PUT fails with this status and code. */
  failPut?: { status: number; error: string };
  /** When set, a PUT holds until it resolves: a slow API server behind the provisioner. */
  putGate?: Promise<void>;
  /** Every request, in arrival order: the real provisioner runs one owner's requests one at a time. */
  private queue: Promise<void> = Promise.resolve();
  /** What happened, in order, as the provisioner finished it. */
  done: string[] = [];
  server = http.createServer((req, res) => {
    const run = this.queue.then(() => this.handle(req, res));
    this.queue = run.catch(() => undefined);
  });

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.method === 'PUT' && this.putGate) await this.putGate;
    this.done.push(req.method ?? '');
    this.calls.push({
      method: req.method ?? '',
      path: req.url ?? '',
      auth: String(req.headers.authorization),
      user: String(req.headers['x-moca-user-token']),
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
    });
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.method === 'PUT') {
      const fail = this.failPut;
      this.failPut = undefined;
      return fail ? reply(fail.status, { error: fail.error }) : reply(200, { ready: 0 });
    }
    return reply(this.podsLeft ? 202 : 200, { remaining: this.podsLeft });
  }
}

describe('a workload with sandboxes of its own (phase 2)', () => {
  let prov: FakeProvisioner;
  const scope = (owner: string) => createHash('sha256').update(owner).digest('hex').slice(0, 32);
  const attachRecord = (owner: string, wl: string, i: number) =>
    redis.hSet(
      'sh:sandbox:records',
      `${wl}-${i}`,
      JSON.stringify({
        sandboxId: `${wl}-${i}`,
        labels: { 'moca.dev/workload': wl, 'moca.dev/owner': scope(owner) },
        capabilities: [],
        capacityMax: 4,
        transport: 'grpc',
      }),
    );
  const wlOf = (owner: string) => cs.ownedBy(owner)[0]![0];

  beforeEach(async () => {
    prov = new FakeProvisioner();
    await new Promise<void>((resolve) => prov.server.listen(0, '127.0.0.1', resolve));
    vi.stubEnv(
      'MOCA_PROVISIONER_URL',
      `http://127.0.0.1:${(prov.server.address() as { port: number }).port}`,
    );
    vi.stubEnv('MOCA_PROVISIONER_TOKEN', 'prov-service-token'); // notsecret
    vi.stubEnv('MOCA_PROVISIONER_DELETE_WAIT_MS', '1');
  });
  afterEach(() => new Promise<void>((resolve) => prov.server.close(() => resolve())));

  it('is refused like any unknown field when no provisioner is configured', async () => {
    vi.stubEnv('MOCA_PROVISIONER_URL', '');
    expect(await create(alice, 'demo', { sandboxes: { count: 1 } })).toEqual({
      status: 400,
      body: { error: 'workload_field_not_allowed' },
    });
    expect(cs.calls).toEqual([]);
  });

  it('refuses bad counts, unknown fields and microvm before reserving anything', async () => {
    for (const [sandboxes, error] of [
      [{ count: 3 }, 'sandboxes_count_invalid'],
      [{ count: 0 }, 'sandboxes_count_invalid'],
      [{ count: '1' }, 'sandboxes_count_invalid'],
      [{ count: 1, tier: 'microvm' }, 'sandbox_tier_unavailable'],
      [{ count: 1, tier: 'gpu' }, 'sandbox_tier_invalid'],
      [{ count: 1, image: 'x' }, 'sandboxes_field_not_allowed'],
      [[], 'sandboxes_field_not_allowed'],
    ] as const) {
      expect(await create(alice, 'demo', { sandboxes })).toEqual({ status: 400, body: { error } });
    }
    expect(cs.calls).toEqual([]);
    expect(await quotaOf(alice)).toBe(0);
  });

  it('activates into provisioning, becomes ready once every sandbox attached, and reports them', async () => {
    const created = await create(alice, 'demo', { sandboxes: { count: 2 } });
    expect(created.body).toMatchObject({
      status: 'awaiting_upload',
      sandboxes: { count: 2, tier: 'container', ready: 0 },
    });
    cs.upload(alice);
    const activated = await call('POST', '/workloads/demo/activate', alice, { revision: REVISION });
    expect(activated).toMatchObject({
      status: 202,
      body: { status: 'provisioning', revision: REVISION, sandboxes: { count: 2, ready: 0 } },
    });
    // Both credentials, and no workload key: the provisioner derives it from the user's token.
    const [put] = prov.calls;
    expect(put).toMatchObject({
      method: 'PUT',
      auth: 'Bearer prov-service-token',
      body: { count: 2, tier: 'container', revision: REVISION },
    });
    expect(put!.path).toMatch(/^\/internal\/v1\/workloads\/demo\/[0-9a-f-]{36}$/);
    // Alice's own API token, verbatim: the provisioner takes the owner from it.
    expect(put!.user).toBe(tokenOf(alice));
    expect(JSON.stringify(put)).not.toContain(wlOf(alice));

    await attachRecord(alice, wlOf(alice), 0);
    // A record of the right workload but another owner is not counted (spec §3.3).
    await redis.hSet(
      'sh:sandbox:records',
      `${wlOf(alice)}-1`,
      JSON.stringify({
        sandboxId: `${wlOf(alice)}-1`,
        labels: { 'moca.dev/workload': wlOf(alice), 'moca.dev/owner': scope(bob) },
      }),
    );
    expect((await call('GET', '/workloads/demo', alice)).body).toMatchObject({
      status: 'provisioning',
      sandboxes: { ready: 1 },
    });
    await attachRecord(alice, wlOf(alice), 1);
    expect(await call('GET', '/workloads/demo', alice)).toMatchObject({
      status: 200,
      body: { status: 'ready', sandboxes: { count: 2, ready: 2 } },
    });
    await redis.hDel('sh:sandbox:records', [`${wlOf(alice)}-0`, `${wlOf(alice)}-1`]);
  });

  it('keeps a failed provisioning on the record, and a repeat activate retries it', async () => {
    await create(alice, 'demo', { sandboxes: { count: 1 } });
    cs.upload(alice);
    prov.failPut = { status: 429, error: 'owner_sandbox_quota_exceeded' };
    expect(await call('POST', '/workloads/demo/activate', alice, { revision: REVISION })).toEqual({
      status: 429,
      body: { error: 'owner_sandbox_quota_exceeded' },
    });
    expect((await call('GET', '/workloads/demo', alice)).body).toMatchObject({
      status: 'provisioning',
      error: 'owner_sandbox_quota_exceeded',
    });
    await attachRecord(alice, wlOf(alice), 0);
    expect(
      await call('POST', '/workloads/demo/activate', alice, { revision: REVISION }),
    ).toMatchObject({ status: 200, body: { status: 'ready' } });
    const body = (await call('GET', '/workloads/demo', alice)).body;
    expect(body).not.toHaveProperty('error');
    expect(prov.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    // A different revision is still refused once frozen.
    expect(
      await call('POST', '/workloads/demo/activate', alice, { revision: OTHER_REVISION }),
    ).toEqual({ status: 409, body: { error: 'workload_already_active' } });
    await redis.hDel('sh:sandbox:records', `${wlOf(alice)}-0`);
  });

  it('drops a failed PUT error once the sandboxes attach and a GET settles it to ready', async () => {
    await create(alice, 'demo', { sandboxes: { count: 1 } });
    cs.upload(alice);
    prov.failPut = { status: 504, error: 'kubernetes_error' };
    expect(
      (await call('POST', '/workloads/demo/activate', alice, { revision: REVISION })).status,
    ).toBe(502);
    expect((await call('GET', '/workloads/demo', alice)).body).toMatchObject({
      status: 'provisioning',
      error: 'kubernetes_error',
    });
    // The PUT had in fact gone through: the sandboxes attach without a second activate.
    await attachRecord(alice, wlOf(alice), 0);
    const got = await call('GET', '/workloads/demo', alice);
    expect(got).toMatchObject({ status: 200, body: { status: 'ready' } });
    expect(got.body).not.toHaveProperty('error');
    const key = `sh:wl:${scope(alice)}:demo`;
    const stored = JSON.parse((await redis.get(key))!);
    expect(stored.status).toBe('ready');
    expect(stored).not.toHaveProperty('error');
    await redis.hDel('sh:sandbox:records', `${wlOf(alice)}-0`);
  });

  it('a provisioner outage is a 502, and the record stays provisioning', async () => {
    await create(alice, 'demo', { sandboxes: { count: 1 } });
    cs.upload(alice);
    prov.failPut = { status: 500, error: 'internal_error' };
    expect(await call('POST', '/workloads/demo/activate', alice, { revision: REVISION })).toEqual({
      status: 502,
      body: { error: 'provisioner_error' },
    });
    expect((await call('GET', '/workloads/demo', alice)).body).toMatchObject({
      status: 'provisioning',
    });
  });

  it('deletes sandboxes first, the Context only once no pod remains, then the record', async () => {
    await create(alice, 'demo', { sandboxes: { count: 1 } });
    cs.upload(alice);
    await call('POST', '/workloads/demo/activate', alice, { revision: REVISION });
    prov.podsLeft = 1;
    // Pods still terminating after the wait: 202, the Context untouched, the record `deleting`.
    expect(await call('DELETE', '/workloads/demo', alice)).toMatchObject({
      status: 202,
      body: { status: 'deleting' },
    });
    expect(cs.contexts.size).toBe(1);
    expect(cs.calls.some((c) => c.method === 'DELETE')).toBe(false);
    // The retry finishes once the pods are gone: sandboxes, then the Context, then the record.
    prov.podsLeft = 0;
    expect(await call('DELETE', '/workloads/demo', alice)).toEqual({ status: 204, body: null });
    expect(cs.contexts.size).toBe(0);
    expect((await call('GET', '/workloads/demo', alice)).body).toMatchObject({ status: 'deleted' });
    expect(await quotaOf(alice)).toBe(0);
    const deletes = prov.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    expect(deletes.every((c) => c.auth === 'Bearer prov-service-token')).toBe(true);
    expect(deletes.every((c) => c.user === tokenOf(alice))).toBe(true);
  });

  it('a DELETE after a PUT the worker gave up on waits for it, and only then deletes the Context', async () => {
    await create(alice, 'demo', { sandboxes: { count: 1 } });
    cs.upload(alice);
    vi.stubEnv('MOCA_PROVISIONER_TIMEOUT_MS', '50');
    let release!: () => void;
    prov.putGate = new Promise<void>((resolve) => (release = resolve));
    // The worker times out; the provisioner is still converging the PUT.
    expect(await call('POST', '/workloads/demo/activate', alice, { revision: REVISION })).toEqual({
      status: 502,
      body: { error: 'provisioner_error' },
    });
    vi.stubEnv('MOCA_PROVISIONER_TIMEOUT_MS', '');
    const deleting = call('DELETE', '/workloads/demo', alice);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Queued behind the PUT: the Context is untouched while it runs.
    expect(cs.calls.some((c) => c.method === 'DELETE')).toBe(false);
    release();
    expect(await deleting).toEqual({ status: 204, body: null });
    // The PUT finished before the DELETE that answered `remaining: 0`.
    expect(prov.done).toEqual(['PUT', 'DELETE']);
    expect(cs.contexts.size).toBe(0);
    expect(await quotaOf(alice)).toBe(0);
  });

  it('passes a 429 through with Retry-After, and a permanent refusal leaves DELETE as the way out', async () => {
    await create(alice, 'demo', { sandboxes: { count: 1 } });
    cs.upload(alice);
    prov.failPut = { status: 429, error: 'owner_sandbox_quota_exceeded' };
    const response = await fetch(`${base}/workloads/demo/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenOf(alice)}` },
      body: JSON.stringify({ revision: REVISION }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
    // The provisioner's own cap below the worker's, or the cluster refusing the objects.
    for (const fail of [
      { status: 400, error: 'sandboxes_count_exceeded' },
      { status: 422, error: 'workload_refused' },
    ]) {
      prov.failPut = fail;
      expect(await call('POST', '/workloads/demo/activate', alice, { revision: REVISION })).toEqual(
        {
          status: fail.status,
          body: { error: fail.error },
        },
      );
      expect((await call('GET', '/workloads/demo', alice)).body).toMatchObject({
        status: 'provisioning',
        error: fail.error,
      });
    }
    expect((await call('DELETE', '/workloads/demo', alice)).status).toBe(204);
    expect(await quotaOf(alice)).toBe(0);
  });

  it('a phase 1 workload never calls the provisioner, even with one configured', async () => {
    await create(alice, 'demo');
    cs.upload(alice);
    expect(
      await call('POST', '/workloads/demo/activate', alice, { revision: REVISION }),
    ).toMatchObject({ status: 200, body: { status: 'ready' } });
    const view = (await call('GET', '/workloads/demo', alice)).body;
    expect(view).not.toHaveProperty('sandboxes');
    expect((await call('DELETE', '/workloads/demo', alice)).status).toBe(204);
    expect(prov.calls).toEqual([]);
  });
});
