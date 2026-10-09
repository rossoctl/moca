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

type Operation = { operationId?: string; security?: { [k: string]: unknown }[] };

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
});

describe('the table matches the handler', () => {
  let server: ReturnType<typeof startServer>;
  let base: string;
  const saved: Record<string, string | undefined> = {};

  function request(method: string, path: string, body?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        new URL(path, base),
        { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

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

  it('404s a path no table entry declares', async () => {
    expect(await request('GET', '/no-such-route')).toBe(404);
  });
});
