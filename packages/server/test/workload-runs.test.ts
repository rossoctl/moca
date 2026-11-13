import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';

// `/runs` with a workloadId, against a real Redis (where B4 keeps workload records), a fake control
// plane for the session-token exchange, and a fake Context Service bundle export.

const { runLeaf } = vi.hoisted(() => ({ runLeaf: vi.fn() }));
vi.mock('@moca/harness/run-leaf', () => ({
  runLeaf: (...args: unknown[]) => runLeaf(...args),
  validateItem: () => null,
  leafSessionId: (env: { sessionId?: string }) => env.sessionId ?? 'leaf',
}));

import { startServer } from '../src/server.js';
import { clearContextBundleCache } from '../src/context-service.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const REVISION = 'c'.repeat(64);
const BUNDLE = gzipSync(Buffer.from('frozen context'));

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const sessionToken = (sub: string, sid: string) =>
  signer.mint({ sub, tenant: sub, roles: [], scope: ['turn:write'], sid, ttlSeconds: 300 });
const apiToken = (sub: string) =>
  signer.mint({ sub, tenant: sub, roles: [], scope: ['api'], ttlSeconds: 300 });

const scope = (owner: string) => createHash('sha256').update(owner).digest('hex').slice(0, 32);

const redis = createClient({ url: REDIS_URL });
let server: ReturnType<typeof startServer>;
let cp: http.Server;
let cs: http.Server;
let csCalls: { method: string; path: string; subject: string }[];
let base: string;
let alice: string;
let bob: string;

async function seed(
  owner: string,
  name: string,
  status: string,
  revision?: string,
  extra: Record<string, unknown> = {},
) {
  const contextName = `w-${randomUUID().replaceAll('-', '')}`;
  await redis.set(
    `sh:wl:${scope(owner)}:${name}`,
    JSON.stringify({
      name,
      owner,
      generation: randomUUID(),
      contextName,
      contextId: randomUUID(),
      status,
      contextType: 'workspace',
      workspace: { size: '1Gi' },
      ...(revision ? { revision } : {}),
      ...extra,
    }),
  );
  return contextName;
}

async function run(owner: string | null, body: Record<string, unknown>) {
  const sid = String(body.sessionId);
  const response = await fetch(`${base}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(owner ? { authorization: `Bearer ${sessionToken(owner, sid)}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const prompt = (workloadId: string, extra: Record<string, unknown> = {}) => ({
  sessionId: `s-${randomUUID()}`,
  kind: 'prompt',
  prompt: 'Inspect the context.',
  workloadId,
  ...extra,
});

const listen = (s: http.Server) =>
  new Promise<string>((resolve) =>
    s.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`),
    ),
  );
const close = (s: http.Server) => new Promise<void>((resolve) => s.close(() => resolve()));

beforeAll(async () => {
  await redis.connect();
});
afterAll(async () => {
  await redis.close();
});

beforeEach(async () => {
  alice = `github:alice-${randomUUID()}`;
  bob = `github:bob-${randomUUID()}`;
  csCalls = [];
  clearContextBundleCache();
  runLeaf.mockReset().mockResolvedValue({ status: 'responded', text: 'ok' });
  cp = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        mode: 'direct',
        anthropicAuthToken: 'sk-test', // notsecret
        anthropicBaseUrl: 'https://litellm.internal/v1',
      }),
    );
  });
  cs = http.createServer((req, res) => {
    csCalls.push({
      method: req.method ?? '',
      path: req.url ?? '',
      subject: String(req.headers['x-context-subject']),
    });
    res
      .writeHead(200, { 'content-type': 'application/vnd.rossoctl.context' })
      .end(Buffer.from(BUNDLE));
  });
  const [cpUrl, csUrl] = await Promise.all([listen(cp), listen(cs)]);
  for (const [key, value] of Object.entries({
    MOCA_CONTEXT_WORKLOADS_ENABLED: '1',
    CONTEXT_SERVICE_URL: csUrl,
    CONTEXT_SERVICE_PUBLIC_URL: 'https://cs.example/',
    CONTEXT_SERVICE_TOKEN: 'cs-service-token', // notsecret
    CONTEXT_SERVICE_NAMESPACE: 'moca',
    SH_SESSION_TOKEN_PUBLIC_KEYS: `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`,
    SH_CONTROL_PLANE_URL: cpUrl,
    SH_EXCHANGE_TOKEN: 'exchange', // notsecret
    REDIS_URL,
  }))
    vi.stubEnv(key, value);
  server = startServer(0);
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([close(server), close(cp), close(cs)]);
});

describe('a run on a workload', () => {
  it("passes the owner's frozen revision to the harness and loads the bundle lazily", async () => {
    const contextName = await seed(alice, 'demo', 'ready', REVISION);
    const res = await run(alice, prompt('demo'));
    expect(res).toEqual({ status: 200, body: { status: 'responded', text: 'ok' } });
    const env = runLeaf.mock.calls[0]![0];
    expect(env.internalContext.revision).toBe(REVISION);
    // The sandbox cache is keyed per owner, so users never share a copy, by a scope that cannot be
    // computed from the owner's name (unlike the workload record's).
    expect(env.internalContext.cacheScope).toMatch(/^[a-f0-9]{32}$/);
    expect(env.internalContext.cacheScope).not.toBe(scope(alice));
    // Nothing is downloaded until the harness finds the sandbox lacks the revision.
    expect(csCalls).toEqual([]);

    expect(await env.internalContext.loadBundle()).toEqual(BUNDLE);
    expect(await env.internalContext.loadBundle()).toEqual(BUNDLE);
    expect(csCalls).toEqual([
      {
        method: 'GET',
        path: `/internal/v1/namespaces/moca/contexts/${contextName}/revisions/${REVISION}/bundle`,
        subject: `user:${alice}`,
      },
    ]);
  });

  it("answers 404 for another user's workload, as for a missing one", async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    expect(await run(bob, prompt('demo'))).toEqual({
      status: 404,
      body: { error: 'workload_not_found' },
    });
    expect(await run(alice, prompt('missing'))).toEqual({
      status: 404,
      body: { error: 'workload_not_found' },
    });
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it.each(['creating', 'awaiting_upload', 'deleting'])(
    'answers 409 for a %s workload',
    async (status) => {
      await seed(alice, 'demo', status);
      expect(await run(alice, prompt('demo'))).toEqual({
        status: 409,
        body: { error: 'workload_not_ready' },
      });
      expect(runLeaf).not.toHaveBeenCalled();
    },
  );

  it('answers 404 for a deleted workload', async () => {
    await seed(alice, 'demo', 'deleted', REVISION);
    expect(await run(alice, prompt('demo'))).toEqual({
      status: 404,
      body: { error: 'workload_not_found' },
    });
  });

  it('keeps one stable cache scope per owner, distinct between owners', async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    await seed(bob, 'demo', 'ready', REVISION);
    await run(alice, prompt('demo'));
    await run(alice, prompt('demo'));
    await run(bob, prompt('demo'));
    const [first, second, other] = runLeaf.mock.calls.map(
      ([env]) => (env as { internalContext: { cacheScope: string } }).internalContext.cacheScope,
    );
    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it('answers 401 token_required for a synchronous workload run without a token', async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    expect(await run(null, prompt('demo'))).toMatchObject({
      status: 401,
      body: { error: 'token_required' },
    });
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it("evicts the deleted workload's cached bundle", async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    await run(alice, prompt('demo'));
    const { loadBundle } = runLeaf.mock.calls[0]![0].internalContext;
    await loadBundle();
    await loadBundle();
    expect(csCalls.filter((c) => c.method === 'GET')).toHaveLength(1);
    const deleted = await fetch(`${base}/workloads/demo`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiToken(alice)}` },
    });
    expect(deleted.status).toBe(204);
    // The next load downloads again: nothing of the deleted workload stayed cached.
    await loadBundle();
    expect(csCalls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('accepts only prompt runs', async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    expect(
      await run(alice, {
        sessionId: 's-1',
        workloadId: 'demo',
        kind: 'solve',
        problemStatement: 'Fix it.',
        repoUrl: 'https://example.com/repo.git',
        ref: 'main',
      }),
    ).toEqual({ status: 400, body: { error: 'workload_run_requires_prompt' } });
  });

  it('still answers 501 when workloads are off', async () => {
    vi.stubEnv('MOCA_CONTEXT_WORKLOADS_ENABLED', '0');
    await seed(alice, 'demo', 'ready', REVISION);
    expect(await run(alice, prompt('demo'))).toEqual({
      status: 501,
      body: { error: 'workload_runs_unavailable' },
    });
  });

  it('refuses asynchronous workload runs with the ADR-0041 removal error, with or without a token', async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    const removed = { status: 400, body: { error: 'async_removed' } };
    expect(await run(alice, prompt('demo', { async: true }))).toMatchObject(removed);
    expect(await run(null, prompt('demo', { async: true }))).toMatchObject(removed);
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('passes contextWritable through to the harness as internalContext.writable', async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    expect(await run(alice, prompt('demo', { contextWritable: true }))).toMatchObject({
      status: 200,
    });
    expect(await run(alice, prompt('demo', { contextWritable: false }))).toMatchObject({
      status: 200,
    });
    expect(await run(alice, prompt('demo'))).toMatchObject({ status: 200 });
    const writable = runLeaf.mock.calls.map(
      ([env]) => (env as { internalContext: { writable: boolean } }).internalContext.writable,
    );
    expect(writable).toEqual([true, false, false]);
  });

  it('never takes the writable flag from a caller-supplied internalContext', async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    await run(alice, prompt('demo', { internalContext: { writable: true } }));
    expect(runLeaf.mock.calls[0]![0].internalContext.writable).toBe(false);
  });

  it.each([['yes'], [1], [null], [{}]])(
    'answers 400 context_writable_invalid for contextWritable %j',
    async (value) => {
      await seed(alice, 'demo', 'ready', REVISION);
      expect(await run(alice, prompt('demo', { contextWritable: value }))).toEqual({
        status: 400,
        body: { error: 'context_writable_invalid' },
      });
      expect(runLeaf).not.toHaveBeenCalled();
    },
  );

  it('answers 400 context_writable_requires_workload without a workloadId', async () => {
    const bare = { sessionId: `s-${randomUUID()}`, kind: 'prompt', prompt: 'Hi.' };
    for (const extra of [{}, { async: true }]) {
      expect(await run(alice, { ...bare, ...extra, contextWritable: true })).toEqual({
        status: 400,
        body: { error: 'context_writable_requires_workload' },
      });
    }
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('accepts and ignores contextWritable false without a workloadId', async () => {
    const res = await run(alice, {
      sessionId: `s-${randomUUID()}`,
      kind: 'prompt',
      prompt: 'Hi.',
      contextWritable: false,
    });
    expect(res).toEqual({ status: 200, body: { status: 'responded', text: 'ok' } });
    expect(runLeaf.mock.calls[0]![0].internalContext).toBeUndefined();
  });

  it('still answers 400 context_writable_invalid without a workloadId', async () => {
    const bare = { sessionId: `s-${randomUUID()}`, kind: 'prompt', prompt: 'Hi.' };
    expect(await run(alice, { ...bare, contextWritable: 'false' })).toEqual({
      status: 400,
      body: { error: 'context_writable_invalid' },
    });
  });
});

describe('a run on a workload with sandboxes of its own (spec §3.3)', () => {
  const sandboxes = { sandboxes: { count: 1, tier: 'container' } };

  it('names the workload key and owner scope, so selection keeps the run on its sandboxes', async () => {
    const contextName = await seed(alice, 'demo', 'ready', REVISION, sandboxes);
    const body = prompt('demo');
    expect((await run(alice, body)).status).toBe(200);
    // A terminal run is persisted: what the 503 case below must not do.
    expect(await redis.keys(`leaf:result:*${String(body.sessionId)}*`)).toHaveLength(1);
    const env = runLeaf.mock.calls[0]![0];
    expect(env.internalContext).toMatchObject({ workload: contextName, ownerScope: scope(alice) });
  });

  it('names the mount for a mounted workload, so the run uses it and never downloads the bundle', async () => {
    await seed(alice, 'demo', 'ready', REVISION, {
      sandboxes: {
        count: 1,
        tier: 'container',
        mount: 'writable',
        claim: { size: '1Gi', access: 'rwo' },
      },
    });
    expect((await run(alice, prompt('demo'))).status).toBe(200);
    expect(runLeaf.mock.calls[0]![0].internalContext).toMatchObject({ mount: 'writable' });
    expect(csCalls).toEqual([]);
  });

  it('leaves both out for a phase 1 workload, which stays on the shared pool', async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    expect((await run(alice, prompt('demo'))).status).toBe(200);
    const ctx = runLeaf.mock.calls[0]![0].internalContext;
    expect(ctx).not.toHaveProperty('workload');
    expect(ctx).not.toHaveProperty('ownerScope');
  });

  it('answers 409 workload_not_ready while provisioning', async () => {
    await seed(alice, 'demo', 'provisioning', REVISION, sandboxes);
    expect(await run(alice, prompt('demo'))).toEqual({
      status: 409,
      body: { error: 'workload_not_ready' },
    });
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('answers 503 workload_sandbox_unavailable, never persisting a result, when none is attached', async () => {
    await seed(alice, 'demo', 'ready', REVISION, sandboxes);
    runLeaf.mockReset().mockResolvedValue({
      status: 'failed',
      reason: 'workload_sandbox_unavailable',
      message: "workload 'w-x': no sandbox of this workload is attached",
    });
    const body = prompt('demo');
    const response = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionToken(alice, String(body.sessionId))}`,
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toMatch(/^[0-9]+$/);
    expect(await response.json()).toEqual({ error: 'workload_sandbox_unavailable' });
    expect(runLeaf).toHaveBeenCalledTimes(1);
    expect(await redis.keys(`leaf:result:*${String(body.sessionId)}*`)).toEqual([]);
  });
});
