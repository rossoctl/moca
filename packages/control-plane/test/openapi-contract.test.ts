import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROUTES } from '../src/routes.js';
import { CP_ERROR_CODES } from '../src/errors.js';
import { CREDENTIAL_NAME_RE } from '../src/credential-store.js';
import { LABEL_KEY_RE, SANDBOX_ID_RE } from '../src/sandbox-handlers.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const doc = () => parse(readFileSync(resolve(REPO_ROOT, 'docs/api/openapi.yaml'), 'utf8'));

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

describe('§9.3 test 3 — contract drift', () => {
  it('is a valid-looking OpenAPI 3.1 document', () => {
    const d = doc();
    expect(String(d.openapi)).toMatch(/^3\.1/);
    expect(d.info?.title).toBeTruthy();
    expect(d.info?.version).toBeTruthy();
  });

  it('documents every implemented route', () => {
    const documented = new Set(operations().map((o) => `${o.method} ${o.path}`));
    const missing = ROUTES.map((r) => `${r.method} ${r.path}`).filter((k) => !documented.has(k));
    expect(missing, 'implemented but undocumented').toEqual([]);
  });

  it('implements every documented route', () => {
    const implemented = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    const extra = operations()
      .map((o) => `${o.method} ${o.path}`)
      .filter((k) => !implemented.has(k));
    expect(extra, 'documented but not implemented').toEqual([]);
  });

  it('uses the same operationId on both sides', () => {
    // The operationId is the join key for everything above; a mismatch would let the two tables
    // describe different routes while both assertions passed.
    const byKey = new Map(ROUTES.map((r) => [`${r.method} ${r.path}`, r.operationId]));
    for (const { path, method, op } of operations()) {
      expect(op.operationId, `${method} ${path}`).toBe(byKey.get(`${method} ${path}`));
    }
  });

  it('marks the auth requirement of every route consistently with the route table', () => {
    const byKey = new Map(ROUTES.map((r) => [`${r.method} ${r.path}`, r.auth]));
    for (const { path, method, op } of operations()) {
      const auth = byKey.get(`${method} ${path}`);
      const schemes = (op.security ?? []).flatMap((s) => Object.keys(s));
      if (auth === 'none') expect(schemes, `${method} ${path}`).toEqual([]);
      if (auth === 'api') expect(schemes, `${method} ${path}`).toEqual(['sessionToken']);
      if (auth === 'exchange') expect(schemes, `${method} ${path}`).toEqual(['exchangeToken']);
      if (auth === 'janitor') expect(schemes, `${method} ${path}`).toEqual(['janitorToken']);
    }
    // Every auth kind the route table uses is one of the four handled above.
    expect([...new Set(ROUTES.map((r) => r.auth))].sort()).toEqual([
      'api',
      'exchange',
      'janitor',
      'none',
    ]);
  });

  it('declares the three security schemes it references', () => {
    expect(Object.keys(doc().components?.securitySchemes ?? {}).sort()).toEqual([
      'exchangeToken',
      'janitorToken',
      'sessionToken',
    ]);
  });

  it('states the sandbox id pattern the code generates (SBX0 §5.1)', () => {
    const param = doc().components.parameters.sandboxId;
    expect(param.schema.pattern).toBe(SANDBOX_ID_RE.source);
  });

  it('documents the Sandbox shape of spec §5.1 exactly', () => {
    const s = doc().components.schemas.Sandbox;
    const fields = [
      'id',
      'owner',
      'name',
      'template',
      'state',
      'reason',
      'createdAt',
      'expiresAt',
      'terminatedAt',
      'labels',
    ];
    expect([...s.required].sort()).toEqual([...fields].sort());
    expect(Object.keys(s.properties).sort()).toEqual([...fields].sort());
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.state.enum).toEqual(['ready', 'terminated']);
    expect(s.properties.reason.enum).toEqual(['deleted', 'expired', null]);
    expect(s.properties.id.pattern).toBe(SANDBOX_ID_RE.source);
  });

  it('states the label rules the code enforces: key pattern, and no character-count limit', () => {
    // The code limits a value to 256 UTF-8 BYTES; `maxLength` counts characters, so it would
    // admit values the server refuses. The limit lives in the description instead.
    const create = doc().paths['/v1/sandboxes'].post.requestBody.content['application/json'];
    for (const labels of [
      doc().components.schemas.Sandbox.properties.labels,
      create.schema.properties.labels,
    ]) {
      expect(labels.propertyNames.pattern).toBe(LABEL_KEY_RE.source);
      expect(labels.additionalProperties).toEqual({ type: 'string' });
      expect(labels.maxProperties).toBe(16);
      expect(labels.description).toContain('256 UTF-8 bytes');
    }
  });

  it('documents the token response with execCa, nullable', () => {
    const ok = doc().paths['/v1/sandboxes/{id}/token'].post.responses['200'];
    const schema = ok.content['application/json'].schema;
    expect([...schema.required].sort()).toEqual(
      ['execCa', 'execEndpoint', 'expiresAt', 'token', 'wrk', 'wsk'].sort(),
    );
    expect(schema.properties.execCa.type).toEqual(['string', 'null']);
  });

  it("documents the janitor's read as spec §5.1 shapes it", () => {
    const ok = doc().paths['/v1/janitor/sandboxes'].get.responses['200'];
    const schema = ok.content['application/json'].schema;
    expect([...schema.required].sort()).toEqual(['live', 'terminated']);
    expect([...schema.properties.live.items.required].sort()).toEqual(['wrk', 'wsk']);
    expect([...schema.properties.terminated.items.required].sort()).toEqual([
      'terminatedAt',
      'wrk',
      'wsk',
    ]);
  });

  it('states the same credential-name pattern the code enforces', () => {
    // Two sources of truth for a validation rule is how a documented API starts lying.
    const param = doc().components.parameters.credentialName;
    expect(param.schema.pattern).toBe(CREDENTIAL_NAME_RE.source);
  });

  it('never describes a RESPONSE that returns a credential value', () => {
    // GET /v1/credentials is metadata only and there is no read-back path anywhere in /v1 (spec §4.2).
    // Scoped to responses on purpose: `PUT /v1/credentials/{name}` legitimately documents `secret` in
    // its REQUEST body -- that is the write-only path. Stringifying whole path objects would flag it.
    const v1Responses = Object.entries(doc().paths as Record<string, Record<string, unknown>>)
      .filter(([path]) => path.startsWith('/v1/'))
      .flatMap(([, byMethod]) =>
        Object.values(byMethod).map((op) => (op as { responses?: unknown }).responses),
      );
    const json = JSON.stringify(v1Responses);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('anthropicAuthToken');
  });

  it('declares a 403 on every route that can answer not_enrolled (SBX0 §4.2)', () => {
    // Every authenticated sandbox-profile route goes through requireEnrolled, and both login
    // completions check enrollment; the janitor's bearer has no subject to enroll.
    const enrollable = ROUTES.filter(
      (r) =>
        r.operationId === 'completeDeviceAuth' ||
        r.operationId === 'refreshAuth' ||
        (r.profiles.includes('sandbox') && r.profiles.length === 1 && r.auth === 'api'),
    ).map((r) => `${r.method} ${r.path}`);
    expect(enrollable.length).toBe(8);
    const missing = operations()
      .filter(({ path, method }) => enrollable.includes(`${method} ${path}`))
      .filter(({ op }) => !(op as { responses?: Record<string, unknown> }).responses?.['403'])
      .map(({ path, method }) => `${method} ${path}`);
    expect(missing, 'can answer 403 not_enrolled, but declares no 403').toEqual([]);
  });

  it('documents EXACTLY the error codes the taxonomy can emit -- no more, no fewer', () => {
    // Set equality against the code's own list, not a transcribed subset, and against the machine-
    // readable `enum` rather than the file's raw text. Both halves matter:
    //   - a hand-listed subset silently stops covering code #19 the day it is added, while still
    //     looking like it covers the taxonomy;
    //   - a raw-text `toContain` search passes on any mention ANYWHERE in the document -- including a
    //     prose `description:` paragraph -- so it would stay green with no error responses documented
    //     at all.
    // Asserting both directions also catches the reverse drift: a code documented that the code
    // cannot actually emit, which sends integrators down a branch that never happens.
    const enumerated = doc().components.schemas.Error.properties.error.enum as string[];
    expect([...enumerated].sort()).toEqual([...CP_ERROR_CODES].sort());
  });
});
