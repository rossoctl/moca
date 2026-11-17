import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROUTES, type RouteSpec } from '../src/routes.js';
import { startServer } from '../src/server.js';

/**
 * The harness twin of packages/control-plane/test/openapi-contract.test.ts: this document and
 * src/routes.ts must describe the same route table, or "the API as a product" degrades into
 * documentation that lies (the control-plane spec's §9.3 test 3 argument, verbatim).
 *
 * The control-plane test compares the document against the dispatcher's own ROUTES table. The
 * data plane has no such table -- its handler is a chain of `if` blocks -- so src/routes.ts is a
 * declaration OF the handler rather than the handler itself. That difference is exactly why the
 * second describe block exists: it drives the real handler and asserts every table entry routes
 * (anything but 404), which is what keeps the declaration from drifting from the if-chain.
 * What it does NOT prove is that a route works; each route's own tests do that.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const doc = () => parse(readFileSync(resolve(REPO_ROOT, 'docs/api/harness-openapi.yaml'), 'utf8'));

type Operation = {
  operationId?: string;
  security?: { [k: string]: unknown }[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
};

/**
 * Resolves a local `$ref` (`#/paths/~1v1~1turn/post/...`) against the document, one level: an
 * alias's request body and responses point at its canonical route's, and the comparison below is
 * between what each one resolves to.
 */
function deref(d: unknown, node: unknown): unknown {
  const ref = (node as { $ref?: unknown } | undefined)?.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  return ref
    .slice(2)
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((at, seg) => (at as Record<string, unknown> | undefined)?.[seg], d);
}

function operations(): { path: string; method: string; op: Operation }[] {
  const out: { path: string; method: string; op: Operation }[] = [];
  for (const [path, byMethod] of Object.entries(
    doc().paths as Record<string, Record<string, Operation>>,
  )) {
    for (const [method, op] of Object.entries(byMethod)) {
      if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
        out.push({ path, method: method.toUpperCase(), op });
      }
    }
  }
  return out;
}

const clientRoutes = () => ROUTES.filter((r) => r.surface === 'client');

describe('contract drift — docs/api/harness-openapi.yaml', () => {
  it('is a valid-looking OpenAPI 3.1 document', () => {
    const d = doc();
    expect(String(d.openapi)).toMatch(/^3\.1/);
    expect(d.info?.title).toBeTruthy();
    expect(d.info?.version).toBeTruthy();
  });

  it('documents every client-surface route', () => {
    const documented = new Set(operations().map((o) => `${o.method} ${o.path}`));
    const missing = clientRoutes()
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !documented.has(k));
    expect(missing, 'client-surface but undocumented').toEqual([]);
  });

  it('implements every documented route', () => {
    const implemented = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    const extra = operations()
      .map((o) => `${o.method} ${o.path}`)
      .filter((k) => !implemented.has(k));
    expect(extra, 'documented but not served').toEqual([]);
  });

  it('agrees with the table on operationId and security', () => {
    for (const r of clientRoutes()) {
      const op = operations().find((o) => o.method === r.method && o.path === r.path)?.op;
      expect(
        op,
        `${r.method} ${r.path} is client-surface but missing from the document`,
      ).toBeTruthy();
      expect(op?.operationId).toBe(r.operationId);
      // 'none' must opt OUT explicitly (security: []); every other auth is the session token.
      expect(op?.security).toEqual(r.auth === 'none' ? [] : [{ sessionToken: [] }]);
    }
  });

  it('gives every operation its own operationId', () => {
    // OpenAPI requires operationIds to be unique in a document, so an alias cannot reuse its
    // canonical route's id even though both run the same handler.
    const ids = operations().map((o) => o.op.operationId);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('documents each supported alias with the contract of the route it duplicates', () => {
    // Change policy decision 3 (#507): /turn and /runs are supported, frozen aliases of /v1, so
    // they are client surface, and their documented contract IS the canonical route's: the same
    // auth, request body and responses. Deprecated aliases stay internal until they are removed.
    const d = doc();
    const aliases = ROUTES.filter((r) => r.aliasOf && !r.deprecated);
    expect(aliases.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /turn', 'POST /runs']);
    for (const r of aliases) {
      expect(r.surface, `${r.path} is a supported alias`).toBe('client');
      const canonical = ROUTES.find((c) => c.method === r.method && c.path === r.aliasOf);
      expect(canonical?.surface).toBe('client');
      expect(r.auth).toBe(canonical?.auth);
      const find = (path: string) =>
        operations().find((o) => o.method === r.method && o.path === path)?.op;
      const alias = find(r.path);
      const target = find(r.aliasOf!);
      expect(alias, `${r.method} ${r.path} is undocumented`).toBeTruthy();
      expect(alias?.security).toEqual(target?.security);
      expect(deref(d, alias?.requestBody)).toEqual(target?.requestBody);
      const resolved = Object.fromEntries(
        Object.entries(alias?.responses ?? {}).map(([code, v]) => [code, deref(d, v)]),
      );
      expect(resolved).toEqual(target?.responses);
    }
    for (const r of ROUTES.filter((x) => x.deprecated)) expect(r.surface).toBe('internal');
  });
});

describe('the table matches the handler', () => {
  let server: ReturnType<typeof startServer>;
  let base: string;
  const saved: Record<string, string | undefined> = {};

  function exchange(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        new URL(path, base),
        { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }
  const request = async (method: string, path: string, body?: string) =>
    (await exchange(method, path, body)).status;

  /**
   * A request per route that the handler answers at its boundary -- before Redis, the work
   * queue, or the context service -- so the guard needs none of them. The answer varies (400
   * for a bad body, 501 with no context service configured); only a 404 would mean the
   * handler does not route the path, which is the one fact under test.
   */
  const probeFor = (r: RouteSpec): { path: string; body?: string } => ({
    // {id} is a template; the handler regex matches any non-empty segment, so a concrete id proves it.
    path: r.path.replace('{id}', 'wl-probe'),
    body: r.method === 'POST' ? '{}' : undefined,
  });

  beforeEach(async () => {
    for (const k of [
      'SH_REQUIRE_AUTH',
      'SH_SESSION_TOKEN_PUBLIC_KEYS',
      'SH_CONTROL_PLANE_URL',
      'SH_EXCHANGE_TOKEN',
      'REDIS_URL',
      'CONTEXT_SERVICE_URL',
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    server = startServer(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    // Awaited: an un-awaited close() can leak the listening socket into the next test's start-up
    // on a slow machine — the port is released asynchronously.
    await new Promise<void>((r) => server.close(() => r()));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('routes every entry in the table', async () => {
    for (const r of ROUTES) {
      const { path, body } = probeFor(r);
      const status = await request(r.method, path, body);
      expect(status, `${r.method} ${r.path} is in ROUTES but the handler 404s it`).not.toBe(404);
    }
  });

  it('answers a supported alias exactly as the route it duplicates', async () => {
    // A boundary probe only (a bad body, answered before Redis or a sandbox), so it pins that the
    // two paths reach the same handler, not that every outcome matches; each route's tests do that.
    for (const r of ROUTES.filter((x) => x.aliasOf && !x.deprecated)) {
      for (const body of ['{}', 'not json', '{"sessionId":""}']) {
        expect(await exchange(r.method, r.path, body), `${r.path} ${body}`).toEqual(
          await exchange(r.method, r.aliasOf!, body),
        );
      }
    }
  });

  it('404s a path no table entry declares', async () => {
    expect(await request('GET', '/no-such-route')).toBe(404);
  });
});
