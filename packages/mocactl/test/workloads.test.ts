import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { uploadUrlProblem } from '../src/api/workloads.js';
import type { Io } from '../src/headless.js';
import { cmdWorkloadCreate, cmdWorkloadDelete, cmdWorkloadGet } from '../src/workloads.js';
import { json, scriptedFetch } from './helpers/fake-fetch.js';
import { fakeHarness } from './helpers/fakes.js';
import { testRuntime } from './helpers/runtime.js';

function io(): Io & { stdout: string; stderr: string[] } {
  const o = {
    stdout: '',
    stderr: [] as string[],
    out: (s: string) => void (o.stdout += s),
    err: (s: string) => void o.stderr.push(s),
  };
  return o;
}

const REV = 'c'.repeat(64);
// testRuntime's clock is 1e12 ms (2001); these are either side of it.
const FUTURE = '2030-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

function grant(over: Record<string, unknown> = {}) {
  return {
    uploadUrl: 'https://cs.example/v1/uploads/up1',
    token: 'grant-1',
    expiresAt: FUTURE,
    method: 'PUT',
    contentType: 'application/vnd.rossoctl.context',
    maxBytes: 1024,
    ...over,
  };
}

const workload = (status: string, over: Record<string, unknown> = {}) => ({
  workloadId: 'demo',
  status,
  contextType: 'workspace',
  workspace: { size: '1Gi' },
  ...over,
});

function contextFile(bytes = 'context-bytes'): string {
  const p = join(mkdtempSync(join(tmpdir(), 'mocactl-ctx-')), 'ctx.context');
  writeFileSync(p, bytes);
  return p;
}

describe('workloads create', () => {
  it('creates, uploads the file to the grant, activates the revision, and prints the id', async () => {
    const { fetch, calls } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ revision: REV, files: 3, bytes: 13 }, 201),
      json(workload('ready', { revision: REV })),
    );
    const rt = testRuntime({ fetchImpl: fetch });
    const o = io();
    const code = await cmdWorkloadCreate(rt, o, {
      contextPath: contextFile(),
      name: 'demo',
      json: false,
    });
    expect(code).toBe(0);
    expect(o.stdout).toBe('demo\n');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://h/workloads',
      'PUT https://cs.example/v1/uploads/up1',
      'POST http://h/workloads/demo/activate',
    ]);
    // The harness gets the API token; Context Service only the grant's own token.
    expect(calls[0]!.headers.authorization).toBe('Bearer a');
    expect(calls[0]!.body).toEqual({ name: 'demo' });
    expect(calls[1]!.headers).toMatchObject({
      authorization: 'Bearer grant-1',
      'content-type': 'application/vnd.rossoctl.context',
      'content-length': '13',
    });
    expect(calls[2]!.body).toEqual({ revision: REV });
    expect(o.stderr.join('\n')).toContain('workload demo is ready');
  });

  it('prints one JSON document with --json', async () => {
    const { fetch } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ revision: REV, files: 3, bytes: 13 }, 201),
      json(workload('ready', { revision: REV })),
    );
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
      contextPath: contextFile(),
      json: true,
    });
    expect(code).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({
      workloadId: 'demo',
      status: 'ready',
      contextType: 'workspace',
      revision: REV,
      files: 3,
      bytes: 13,
    });
    expect(o.stdout.trimEnd().split('\n')).toHaveLength(1);
  });

  it('sends --sandboxes and --mount, then waits for the provisioning workload to be ready', async () => {
    const own = { count: 2, tier: 'container' };
    const mounted = { size: '1Gi', mount: 'writable' };
    const { fetch, calls } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ revision: REV, files: 1, bytes: 13 }, 201),
      json(
        workload('provisioning', {
          revision: REV,
          workspace: mounted,
          sandboxes: { ...own, ready: 0 },
        }),
        202,
      ),
      json(
        workload('provisioning', {
          revision: REV,
          workspace: mounted,
          sandboxes: { ...own, ready: 1 },
        }),
      ),
      json(
        workload('ready', { revision: REV, workspace: mounted, sandboxes: { ...own, ready: 2 } }),
      ),
    );
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
      contextPath: contextFile(),
      name: 'demo',
      sandboxes: 2,
      mount: 'writable',
      json: true,
    });
    expect(code).toBe(0);
    expect(calls[0]!.body).toEqual({
      name: 'demo',
      sandboxes: { count: 2 },
      workspace: { mount: 'writable' },
    });
    expect(calls.slice(3).map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://h/workloads/demo',
      'GET http://h/workloads/demo',
    ]);
    expect(JSON.parse(o.stdout)).toMatchObject({
      workloadId: 'demo',
      status: 'ready',
      sandboxes: { count: 2, ready: 2 },
      mount: 'writable',
    });
    expect(o.stderr.join('\n')).toContain('provisioning its sandboxes');
  });

  it('sends only sandboxes without --mount, and nothing new without --sandboxes', async () => {
    const { fetch, calls } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ revision: REV }, 201),
      json(workload('ready', { revision: REV, sandboxes: { count: 1, ready: 1 } })),
    );
    expect(
      await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), io(), {
        contextPath: contextFile(),
        name: 'demo',
        sandboxes: 1,
        json: false,
      }),
    ).toBe(0);
    expect(calls[0]!.body).toEqual({ name: 'demo', sandboxes: { count: 1 } });
  });

  it('refuses --mount without --sandboxes before any request', async () => {
    const { fetch, calls } = scriptedFetch();
    const o = io();
    expect(
      await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
        contextPath: contextFile(),
        mount: 'read-only',
        json: false,
      }),
    ).toBe(2);
    expect(o.stderr.join('\n')).toContain('--mount needs --sandboxes N');
    expect(calls).toHaveLength(0);
  });

  it('deletes a workload whose provisioning records an error, or never finishes', async () => {
    const own = { count: 1, tier: 'container', ready: 0 };
    const failed = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ revision: REV }, 201),
      json(workload('provisioning', { revision: REV, sandboxes: own }), 202),
      json(workload('provisioning', { revision: REV, sandboxes: own, error: 'workload_refused' })),
      new Response(null, { status: 204 }),
    );
    const o = io();
    expect(
      await cmdWorkloadCreate(testRuntime({ fetchImpl: failed.fetch }), o, {
        contextPath: contextFile(),
        name: 'demo',
        sandboxes: 1,
        json: false,
      }),
    ).toBe(1);
    expect(o.stderr.join('\n')).toContain('failed to provision: workload_refused');
    expect(failed.calls.at(-1)!.method).toBe('DELETE');

    const slow = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ revision: REV }, 201),
      json(workload('provisioning', { revision: REV, sandboxes: own }), 202),
      new Response(null, { status: 204 }),
    );
    const t = io();
    expect(
      await cmdWorkloadCreate(testRuntime({ fetchImpl: slow.fetch }), t, {
        contextPath: contextFile(),
        name: 'demo',
        sandboxes: 1,
        readyTimeoutMs: 0,
        json: false,
      }),
    ).toBe(1);
    expect(t.stderr.join('\n')).toContain('still provisioning (0 of 1 sandboxes attached)');
    expect(slow.calls.at(-1)!.method).toBe('DELETE');
  });

  it('activates once more when the seed bundle was lost, then deletes if it is lost again', async () => {
    const own = { count: 1, tier: 'container', ready: 0 };
    const lost = { revision: REV, sandboxes: own, error: 'seed_bundle_missing' };
    const recovered = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ revision: REV }, 201),
      json(workload('provisioning', { revision: REV, sandboxes: own }), 202),
      json(workload('provisioning', lost)),
      json(workload('provisioning', { revision: REV, sandboxes: own }), 202),
      json(workload('ready', { revision: REV, sandboxes: { ...own, ready: 1 } })),
    );
    const o = io();
    expect(
      await cmdWorkloadCreate(testRuntime({ fetchImpl: recovered.fetch }), o, {
        contextPath: contextFile(),
        name: 'demo',
        sandboxes: 1,
        json: false,
      }),
    ).toBe(0);
    expect(recovered.calls.slice(2).map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://h/workloads/demo/activate',
      'GET http://h/workloads/demo',
      'POST http://h/workloads/demo/activate',
      'GET http://h/workloads/demo',
    ]);
    expect(recovered.calls[4]!.body).toEqual({ revision: REV });
    expect(o.stderr.join('\n')).toContain('lost its seed bundle; activating again');

    const twice = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ revision: REV }, 201),
      json(workload('provisioning', { revision: REV, sandboxes: own }), 202),
      json(workload('provisioning', lost)),
      json(workload('provisioning', lost), 202),
      new Response(null, { status: 204 }),
    );
    const t = io();
    expect(
      await cmdWorkloadCreate(testRuntime({ fetchImpl: twice.fetch }), t, {
        contextPath: contextFile(),
        name: 'demo',
        sandboxes: 1,
        json: false,
      }),
    ).toBe(1);
    expect(t.stderr.join('\n')).toContain('failed to provision: seed_bundle_missing');
    expect(twice.calls.at(-1)!.method).toBe('DELETE');
  });

  it('replaces an already-expired grant before uploading', async () => {
    const { fetch, calls } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant({ expiresAt: PAST }) }, 201),
      json(grant({ token: 'grant-2', uploadUrl: 'https://cs.example/v1/uploads/up2' }), 201),
      json({ revision: REV }, 201),
      json(workload('ready', { revision: REV })),
    );
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), io(), {
      contextPath: contextFile(),
      json: false,
    });
    expect(code).toBe(0);
    expect(calls[1]!.url).toBe('http://h/workloads/demo/uploads');
    expect(calls[2]!.url).toBe('https://cs.example/v1/uploads/up2');
    expect(calls[2]!.headers.authorization).toBe('Bearer grant-2');
  });

  it('retries once with a fresh grant when the upload answers 401', async () => {
    const { fetch, calls } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ error: 'capability_expired' }, 401),
      json(grant({ token: 'grant-2' }), 201),
      json({ revision: REV }, 201),
      json(workload('ready', { revision: REV })),
    );
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
      contextPath: contextFile(),
      json: false,
    });
    expect(code).toBe(0);
    expect(calls.map((c) => c.method + ' ' + c.url)).toEqual([
      'POST http://h/workloads',
      'PUT https://cs.example/v1/uploads/up1',
      'POST http://h/workloads/demo/uploads',
      'PUT https://cs.example/v1/uploads/up1',
      'POST http://h/workloads/demo/activate',
    ]);
    expect(calls[3]!.headers.authorization).toBe('Bearer grant-2');
    expect(o.stderr.join('\n')).toContain('retrying with a fresh one');
  });

  it('retries only once, then deletes the workload it created', async () => {
    const { fetch, calls } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ error: 'capability_expired' }, 401),
      json(grant({ token: 'grant-2' }), 201),
      json({ error: 'capability_expired' }, 401),
      new Response(null, { status: 204 }),
    );
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
      contextPath: contextFile(),
      json: false,
    });
    expect(code).toBe(1);
    expect(calls.at(-1)!.method + ' ' + calls.at(-1)!.url).toBe('DELETE http://h/workloads/demo');
    const err = o.stderr.join('\n');
    expect(err).toContain('Context Service refused the upload: 401 capability_expired');
    expect(err).toContain('deleted workload demo');
    expect(o.stdout).toBe('');
  });

  it("refuses a file larger than the grant's maxBytes without uploading it", async () => {
    const { fetch, calls } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant({ maxBytes: 4 }) }, 201),
      new Response(null, { status: 204 }),
    );
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
      contextPath: contextFile('0123456789'),
      json: false,
    });
    expect(code).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(o.stderr.join('\n')).toContain('is 10 bytes; Context Service accepts at most 4');
  });

  it('refuses a missing or empty file, and a bad --name, before any request', async () => {
    const { fetch, calls } = scriptedFetch();
    const rt = testRuntime({ fetchImpl: fetch });
    const missing = io();
    expect(
      await cmdWorkloadCreate(rt, missing, {
        contextPath: '/nonexistent/ctx.context',
        json: false,
      }),
    ).toBe(2);
    expect(missing.stderr.join('\n')).toContain('does not exist');
    expect(await cmdWorkloadCreate(rt, io(), { contextPath: contextFile(''), json: false })).toBe(
      2,
    );
    expect(
      await cmdWorkloadCreate(rt, io(), {
        contextPath: contextFile(),
        name: 'Not_A_Name',
        json: false,
      }),
    ).toBe(2);
    expect(calls).toEqual([]);
  });

  it('generates the name client-side when --name is omitted', async () => {
    const { fetch, calls } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ revision: REV }, 201),
      json(workload('ready', { revision: REV })),
    );
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), io(), {
      contextPath: contextFile(),
      json: false,
    });
    expect(code).toBe(0);
    // The harness's own pattern for a generated name: `wl-` and 8 hex, a valid workload id.
    expect(calls[0]!.body).toEqual({ name: expect.stringMatching(/^wl-[a-f0-9]{8}$/) });
  });

  it('names the workload to delete when the POST reply is lost', async () => {
    const { fetch } = scriptedFetch(new TypeError('fetch failed'));
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
      contextPath: contextFile(),
      json: false,
    });
    expect(code).toBe(1);
    expect(o.stderr.join('\n')).toMatch(
      /workload (wl-[a-f0-9]{8}) may have been created: `mocactl workloads delete \1`/,
    );
  });

  it('names the workload to delete when Ctrl-C interrupts the POST', async () => {
    const ac = new AbortController();
    const { fetch } = scriptedFetch(() => {
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
      contextPath: contextFile(),
      name: 'demo',
      json: false,
      signal: ac.signal,
    });
    expect(code).toBe(130);
    expect(o.stderr.join('\n')).toContain(
      'workload demo may have been created: `mocactl workloads delete demo`',
    );
  });

  it("refuses a grant whose content type is not Context Service's", async () => {
    for (const contentType of ['application/octet-stream', undefined]) {
      const { fetch, calls } = scriptedFetch(
        json({ ...workload('awaiting_upload'), upload: grant({ contentType }) }, 201),
      );
      const o = io();
      const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
        contextPath: contextFile(),
        name: 'demo',
        json: false,
      });
      expect(code).toBe(1);
      expect(calls).toHaveLength(1);
      expect(o.stderr.join('\n')).toContain('invalid upload grant');
    }
  });

  it('refuses when not logged in', async () => {
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ auth: null }), o, {
      contextPath: contextFile(),
      json: false,
    });
    expect(code).toBe(2);
    expect(o.stderr.join('\n')).toContain('not logged in');
  });

  it("surfaces the harness's error codes", async () => {
    const cases: Array<[Response, string]> = [
      [json({ error: 'workloads_unavailable' }, 501), 'workloads are not enabled on this harness'],
      [json({ error: 'workload_quota_exceeded' }, 429), 'mocactl workloads delete ID'],
      [json({ error: 'workload_name_taken' }, 409), "already have a workload named 'demo'"],
      [json({ error: 'context_service_error' }, 502), '502 context_service_error'],
    ];
    for (const [reply, message] of cases) {
      const { fetch, calls } = scriptedFetch(reply);
      const o = io();
      const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
        contextPath: contextFile(),
        name: 'demo',
        json: false,
      });
      expect(code).toBe(1);
      expect(calls).toHaveLength(1);
      expect(o.stderr.join('\n')).toContain(message);
    }
  });

  it('surfaces an activation refusal and deletes the workload', async () => {
    const { fetch, calls } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ revision: REV }, 201),
      json({ error: 'revision_mismatch' }, 409),
      new Response(null, { status: 204 }),
    );
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
      contextPath: contextFile(),
      json: false,
    });
    expect(code).toBe(1);
    expect(calls.at(-1)!.method).toBe('DELETE');
    expect(o.stderr.join('\n')).toContain('409 revision_mismatch');
  });

  it('says how to clean up when the rollback delete fails too', async () => {
    const { fetch } = scriptedFetch(
      json({ ...workload('awaiting_upload'), upload: grant() }, 201),
      json({ error: 'internal' }, 500),
      json({ error: 'context_service_error' }, 502),
    );
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
      contextPath: contextFile(),
      json: false,
    });
    expect(code).toBe(1);
    expect(o.stderr.join('\n')).toContain('run `mocactl workloads delete demo`');
  });

  it('never sends the grant over plain HTTP to a non-loopback host', async () => {
    const { fetch, calls } = scriptedFetch(
      json(
        {
          ...workload('awaiting_upload'),
          upload: grant({ uploadUrl: 'http://cs.example/v1/uploads/up1' }),
        },
        201,
      ),
      new Response(null, { status: 204 }),
    );
    const o = io();
    const code = await cmdWorkloadCreate(testRuntime({ fetchImpl: fetch }), o, {
      contextPath: contextFile(),
      json: false,
    });
    expect(code).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(o.stderr.join('\n')).toContain('must use HTTPS');
    expect(uploadUrlProblem('https://cs.example/x')).toBeUndefined();
    expect(uploadUrlProblem('http://127.0.0.1:8080/x')).toBeUndefined();
    expect(uploadUrlProblem('http://[::1]/x')).toBeUndefined();
    expect(uploadUrlProblem('http://localhost/x')).toBeUndefined();
    expect(uploadUrlProblem('http://10.0.0.1/x')).toBeDefined();
    expect(uploadUrlProblem('ftp://cs.example/x')).toBeDefined();
  });

  it('streams the file to a real loopback server with its length and type', async () => {
    const seen: Array<{
      method?: string;
      url?: string;
      headers: IncomingMessage['headers'];
      body: Buffer;
    }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        const send = (status: number, body?: unknown) =>
          res
            .writeHead(status, { 'content-type': 'application/json' })
            .end(body === undefined ? undefined : JSON.stringify(body));
        if (req.url === '/workloads') {
          const { port } = server.address() as AddressInfo;
          return send(201, {
            ...workload('awaiting_upload'),
            upload: grant({
              uploadUrl: `http://127.0.0.1:${port}/v1/uploads/up1`,
              maxBytes: 1 << 20,
            }),
          });
        }
        if (req.url === '/v1/uploads/up1') return send(201, { revision: REV, files: 1, bytes: 5 });
        if (req.url === '/workloads/demo/activate') return send(200, workload('ready'));
        send(404, { error: 'not_found' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    onTestFinished(() => new Promise<void>((r) => server.close(() => r())));
    const { port } = server.address() as AddressInfo;
    const rt = testRuntime({
      fetchImpl: fetch,
      harness: fakeHarness([], { baseUrl: async () => `http://127.0.0.1:${port}` }),
    });
    const payload = Buffer.alloc(300_000, 7);
    const path = join(mkdtempSync(join(tmpdir(), 'mocactl-ctx-')), 'big.context');
    writeFileSync(path, payload);
    const o = io();
    const code = await cmdWorkloadCreate(rt, o, { contextPath: path, json: false });
    expect(o.stderr.join('\n')).not.toContain('refused');
    expect(code).toBe(0);
    const put = seen.find((s) => s.method === 'PUT')!;
    expect(put.headers['content-length']).toBe(String(payload.length));
    expect(put.headers['content-type']).toBe('application/vnd.rossoctl.context');
    expect(put.headers.authorization).toBe('Bearer grant-1');
    expect(put.body.equals(payload)).toBe(true);
  });
});

describe('workloads get', () => {
  it('prints the workload as JSON', async () => {
    const { fetch, calls } = scriptedFetch(json(workload('ready', { revision: REV, extra: 1 })));
    const o = io();
    expect(
      await cmdWorkloadGet(testRuntime({ fetchImpl: fetch }), o, { id: 'demo', json: true }),
    ).toBe(0);
    expect(calls[0]!.method + ' ' + calls[0]!.url).toBe('GET http://h/workloads/demo');
    expect(calls[0]!.headers.authorization).toBe('Bearer a');
    expect(JSON.parse(o.stdout)).toEqual({
      workloadId: 'demo',
      status: 'ready',
      contextType: 'workspace',
      workspace: { size: '1Gi' },
      revision: REV,
      sandboxes: null,
    });
  });

  it("shows a phase 2 workload's sandboxes and mount", async () => {
    const { fetch } = scriptedFetch(
      json(
        workload('provisioning', {
          revision: REV,
          workspace: { size: '1Gi', mount: 'read-only' },
          sandboxes: { count: 2, tier: 'container', ready: 1 },
          error: 'seed_bundle_missing',
        }),
      ),
      json(
        workload('ready', {
          revision: REV,
          workspace: { size: '1Gi', mount: 'read-only' },
          sandboxes: { count: 2, tier: 'container', ready: 2 },
        }),
      ),
    );
    const rt = testRuntime({ fetchImpl: fetch });
    const o = io();
    expect(await cmdWorkloadGet(rt, o, { id: 'demo', json: true })).toBe(0);
    expect(JSON.parse(o.stdout)).toMatchObject({
      sandboxes: { count: 2, tier: 'container', ready: 1 },
      workspace: { mount: 'read-only' },
      error: 'seed_bundle_missing',
    });
    const table = io();
    expect(await cmdWorkloadGet(rt, table, { id: 'demo', json: false })).toBe(0);
    expect(table.stdout.trimEnd().split('\n')[1]).toMatch(
      /^demo\s+ready\s+workspace\s+1Gi\s+2\/2\s+read-only\s+c{64}$/,
    );
  });

  it('prints a table, with nulls for what an unactivated workload lacks in JSON', async () => {
    const { fetch } = scriptedFetch(
      json(workload('awaiting_upload')),
      json({ workloadId: 'demo', status: 'deleted' }),
    );
    const rt = testRuntime({ fetchImpl: fetch });
    const table = io();
    expect(await cmdWorkloadGet(rt, table, { id: 'demo', json: false })).toBe(0);
    const lines = table.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^WORKLOAD\s+STATUS\s+TYPE\s+SIZE\s+SANDBOXES\s+MOUNT\s+REVISION$/);
    expect(lines[1]).toMatch(/^demo\s+awaiting_upload\s+workspace\s+1Gi\s+-\s+-\s+-$/);
    const bare = io();
    expect(await cmdWorkloadGet(rt, bare, { id: 'demo', json: true })).toBe(0);
    expect(JSON.parse(bare.stdout)).toEqual({
      workloadId: 'demo',
      status: 'deleted',
      contextType: null,
      workspace: null,
      revision: null,
      sandboxes: null,
    });
  });

  it('exits 1 for a missing workload and 2 for an invalid id', async () => {
    const { fetch, calls } = scriptedFetch(json({ error: 'workload_not_found' }, 404));
    const rt = testRuntime({ fetchImpl: fetch });
    const o = io();
    expect(await cmdWorkloadGet(rt, o, { id: 'gone', json: true })).toBe(1);
    expect(o.stderr.join('\n')).toContain("no workload 'gone' (or it is not yours)");
    expect(o.stdout).toBe('');
    expect(await cmdWorkloadGet(rt, io(), { id: '../etc', json: false })).toBe(2);
    expect(calls).toHaveLength(1);
  });
});

describe('workloads delete', () => {
  it('deletes and prints {workloadId, status} with --json', async () => {
    const { fetch, calls } = scriptedFetch(new Response(null, { status: 204 }));
    const o = io();
    expect(
      await cmdWorkloadDelete(testRuntime({ fetchImpl: fetch }), o, { id: 'demo', json: true }),
    ).toBe(0);
    expect(calls[0]!.method + ' ' + calls[0]!.url).toBe('DELETE http://h/workloads/demo');
    expect(calls[0]!.headers.authorization).toBe('Bearer a');
    expect(JSON.parse(o.stdout)).toEqual({ workloadId: 'demo', status: 'deleted' });
    expect(o.stderr.join('\n')).toContain('deleted workload demo');
  });

  it('surfaces 404 and 409', async () => {
    const { fetch } = scriptedFetch(
      json({ error: 'workload_not_found' }, 404),
      json({ error: 'workload_state_changed' }, 409),
    );
    const rt = testRuntime({ fetchImpl: fetch });
    const missing = io();
    expect(await cmdWorkloadDelete(rt, missing, { id: 'demo', json: false })).toBe(1);
    expect(missing.stderr.join('\n')).toContain("no workload 'demo'");
    const raced = io();
    expect(await cmdWorkloadDelete(rt, raced, { id: 'demo', json: false })).toBe(1);
    expect(raced.stderr.join('\n')).toContain('409 workload_state_changed');
  });
});
