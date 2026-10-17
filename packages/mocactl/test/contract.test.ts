import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ControlPlaneClient } from '../src/api/control-plane.js';
import { SandboxApiClient } from '../src/sbx/api.js';
import { KNOWN_FRAME_TYPES } from '../src/api/frames.js';
import { readSse, toFrame } from '../src/api/sse-parser.js';
import { json, scriptedFetch } from './helpers/fake-fetch.js';
import { streamOf } from './helpers/sse.js';

const root = new URL('../../../', import.meta.url);
const openapi = parse(readFileSync(new URL('docs/api/openapi.yaml', root), 'utf8')) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

// Every control-plane call the client makes, with the response fields it reads and the request
// fields it sends. Adding a client call without a row here fails 'covers every call' below.
const USED: Array<{ method: string; path: string; reads?: string[]; sends?: string[] }> = [
  { method: 'get', path: '/healthz' },
  { method: 'get', path: '/readyz' },
  { method: 'get', path: '/v1/discovery', reads: ['harnessUrl', 'sandboxTiers', 'version'] },
  {
    method: 'post',
    path: '/v1/auth/device',
    reads: ['deviceCode', 'userCode', 'verificationUri', 'interval', 'expiresIn'],
  },
  {
    method: 'post',
    path: '/v1/auth/device/token',
    reads: ['token', 'subject', 'expiresAt', 'refreshToken', 'refreshExpiresAt'],
    sends: ['deviceCode', 'label'],
  },
  {
    method: 'post',
    path: '/v1/auth/token',
    reads: ['token', 'subject', 'expiresAt', 'refreshToken', 'refreshExpiresAt'],
    sends: ['grant_type', 'refresh_token'],
  },
  { method: 'post', path: '/v1/auth/revoke', sends: ['token'] },
  { method: 'post', path: '/v1/auth/revoke-all', reads: ['revoked'] },
  { method: 'get', path: '/v1/me', reads: ['subject', 'tenant', 'roles'] },
  { method: 'get', path: '/v1/sessions', reads: ['sessions', 'nextCursor'] },
  {
    method: 'post',
    path: '/v1/sessions',
    reads: ['sessionId', 'token', 'expiresAt', 'model', 'modelVerified'],
    sends: ['credentials', 'sandbox', 'configRef', 'model'],
  },
  { method: 'get', path: '/v1/sessions/{id}', reads: ['model'] },
  { method: 'delete', path: '/v1/sessions/{id}' },
  { method: 'post', path: '/v1/sessions/{id}/token', reads: ['token', 'expiresAt'] },
  { method: 'get', path: '/v1/credentials', reads: ['credentials'] },
  { method: 'put', path: '/v1/credentials/{name}' },
  { method: 'delete', path: '/v1/credentials/{name}' },
  {
    method: 'post',
    path: '/v1/config-bundles',
    reads: ['digest', 'uploaded'],
    sends: ['digest', 'tar'],
  },
  { method: 'delete', path: '/v1/config-bundles/{digest}' },
  { method: 'get', path: '/v1/models', reads: ['credential', 'models'] },
  { method: 'get', path: '/v1/sessions/{id}/models', reads: ['credential', 'models'] },
  {
    method: 'patch',
    path: '/v1/sessions/{id}',
    reads: ['model', 'modelVerified'],
    sends: ['model'],
  },
];

// The same for `mocactl sbx`'s SandboxApiClient (SBX0 §5.1), beyond the calls it inherits.
const SBX_USED: Array<{ method: string; path: string; reads?: string[]; sends?: string[] }> = [
  { method: 'get', path: '/v1/discovery', reads: ['profile'] },
  { method: 'get', path: '/v1/templates', reads: ['templates'] },
  {
    method: 'post',
    path: '/v1/sandboxes',
    reads: ['id', 'template', 'expiresAt'],
    sends: ['template', 'name', 'labels'],
  },
  { method: 'get', path: '/v1/sandboxes', reads: ['sandboxes'] },
  { method: 'get', path: '/v1/sandboxes/{id}', reads: ['id', 'state', 'reason', 'expiresAt'] },
  { method: 'delete', path: '/v1/sandboxes/{id}', reads: ['id', 'state', 'reason'] },
  {
    method: 'post',
    path: '/v1/sandboxes/{id}/token',
    reads: ['token', 'expiresAt', 'execEndpoint', 'wrk', 'wsk', 'execCa'],
  },
];

// The fields of each Sandbox and template `mocactl sbx ls` / `templates` print.
const SBX_SANDBOX_READS = ['id', 'owner', 'name', 'template', 'state', 'reason', 'expiresAt'];
const SBX_TEMPLATE_READS = ['id', 'description', 'tools'];

// Codes the client branches on (api/errors.ts, core/session-manager.ts, sbx/commands.ts).
const CODES_USED = [
  'token_required',
  'token_invalid',
  'token_expired',
  'session_not_found',
  'session_mismatch',
  'endpoint_unresolved',
  'authorization_pending',
  'device_code_expired',
  'identity_provider_misconfigured',
  'redis_unavailable',
  'credential_unavailable',
  'internal_error',
  'credential_required',
  'credential_ambiguous',
  'config_bundle_not_found',
  'forbidden',
  'model_unavailable',
  'model_catalog_unavailable',
  'not_enrolled',
  'sandbox_not_found',
];

function responseSchema(op: any): any {
  const ok = Object.entries(op.responses).find(([s]) => s.startsWith('2'));
  const schema = (ok?.[1] as any)?.content?.['application/json']?.schema;
  return resolveSchema(schema);
}

// `$ref` to a component, `allOf` and `oneOf`/`anyOf` all appear in 2xx schemas; flatten them to one
// properties map. For `oneOf`/`anyOf` that is the union of every branch's properties: the check is
// that each field the client reads exists somewhere in the response.
function resolveSchema(s: any): any {
  if (!s) return s;
  if (s.$ref) return resolveSchema(openapi.components.schemas[s.$ref.split('/').pop()]);
  const parts = s.allOf ?? s.oneOf ?? s.anyOf;
  if (parts) {
    return {
      properties: Object.assign({}, ...parts.map((p: any) => resolveSchema(p)?.properties)),
    };
  }
  return s;
}

describe('control-plane contract (docs/api/openapi.yaml)', () => {
  it.each(USED)(
    '$method $path exists with the fields the client relies on',
    ({ method, path, reads, sends }) => {
      const op = openapi.paths[path]?.[method];
      expect(op, `${method} ${path} missing from openapi.yaml`).toBeDefined();
      const schema = responseSchema(op);
      for (const f of reads ?? []) expect(Object.keys(schema?.properties ?? {})).toContain(f);
      const req = op.requestBody?.content?.['application/json']?.schema;
      for (const f of sends ?? []) expect(Object.keys(req?.properties ?? {})).toContain(f);
    },
  );

  it('every error code the client branches on is in the Error enum', () => {
    const codes = openapi.components.schemas.Error.properties.error.enum;
    for (const c of CODES_USED) expect(codes).toContain(c);
  });

  it('covers every call the client makes', async () => {
    const reply = () => json({ credentials: [], sessions: [], nextCursor: null });
    const { fetch, calls } = scriptedFetch(...Array.from({ length: 30 }, () => reply));
    const c = new ControlPlaneClient('http://cp', () => 't', fetch);
    const invokedMethods = new Set<string>();
    const handler: ProxyHandler<ControlPlaneClient> = {
      get(target, prop) {
        if (typeof prop === 'string') {
          const desc = Object.getOwnPropertyDescriptor(ControlPlaneClient.prototype, prop);
          if (
            desc &&
            typeof desc.value === 'function' &&
            !desc.value.toString().includes('private')
          ) {
            invokedMethods.add(prop);
          }
        }
        return (target as any)[prop];
      },
    };
    const cProxy = new Proxy(c, handler);
    await cProxy.healthz();
    await cProxy.readyz();
    await cProxy.discovery();
    await cProxy.startDeviceAuth();
    await cProxy.pollDeviceAuth('d');
    await cProxy.refreshAuth('mrt_x');
    await cProxy.revokeAuth('mrt_x');
    await cProxy.revokeAllAuth();
    await cProxy.me();
    await cProxy.listSessions();
    await cProxy.createSession({});
    await cProxy.getSession('ID');
    await cProxy.deleteSession('ID');
    await cProxy.mintSessionToken('ID');
    await cProxy.listCredentials();
    await cProxy.putCredential('NAME', {
      kind: 'bearer',
      consumer: 'inference',
      destination: { hosts: [] },
      secret: {},
    });
    await cProxy.deleteCredential('NAME');
    await cProxy.putConfigBundle({ digest: 'sha256:x', tar: '' });
    await cProxy.deleteConfigBundle('DIGEST');
    await cProxy.listModels('cred');
    await cProxy.listSessionModels('ID');
    await cProxy.setSessionModel('ID', null);
    const seen = calls.map((k) => {
      const path = new URL(k.url).pathname
        .replace('/ID', '/{id}')
        .replace('/NAME', '/{name}')
        .replace('/DIGEST', '/{digest}');
      return `${k.method.toLowerCase()} ${path}`;
    });
    expect(new Set(seen)).toEqual(new Set(USED.map((u) => `${u.method} ${u.path}`)));

    // Assert that every public method on ControlPlaneClient is tested.
    // Adding a new public method must make this test fail until it is called and added to USED.
    const publicMethods = new Set(
      Object.getOwnPropertyNames(ControlPlaneClient.prototype)
        .filter((m) => m !== 'constructor')
        .filter((m) => {
          const desc = Object.getOwnPropertyDescriptor(ControlPlaneClient.prototype, m);
          return desc && typeof desc.value === 'function';
        })
        .filter(
          (m) =>
            !ControlPlaneClient.prototype[m as keyof ControlPlaneClient]
              .toString()
              .includes('private'),
        ),
    );
    expect(invokedMethods).toEqual(publicMethods);
  });
});

describe('sandbox-service contract (docs/api/openapi.yaml, SBX0 §5.1)', () => {
  it.each(SBX_USED)(
    '$method $path exists with the fields mocactl sbx relies on',
    ({ method, path, reads, sends }) => {
      const op = openapi.paths[path]?.[method];
      expect(op, `${method} ${path} missing from openapi.yaml`).toBeDefined();
      const schema = responseSchema(op);
      for (const f of reads ?? []) expect(Object.keys(schema?.properties ?? {})).toContain(f);
      const req = op.requestBody?.content?.['application/json']?.schema;
      for (const f of sends ?? []) expect(Object.keys(req?.properties ?? {})).toContain(f);
    },
  );

  it('the Sandbox items and templates hold the fields ls and templates print', () => {
    const sandbox = resolveSchema(openapi.components.schemas.Sandbox);
    for (const f of SBX_SANDBOX_READS) expect(Object.keys(sandbox.properties)).toContain(f);
    const list = responseSchema(openapi.paths['/v1/sandboxes'].get);
    expect(resolveSchema(list.properties.sandboxes.items)).toEqual(sandbox);
    const templates = responseSchema(openapi.paths['/v1/templates'].get);
    for (const f of SBX_TEMPLATE_READS) {
      expect(Object.keys(templates.properties.templates.items.properties)).toContain(f);
    }
  });

  it('covers every call SandboxApiClient adds', async () => {
    const reply = () => json({ templates: [], sandboxes: [] });
    const { fetch, calls } = scriptedFetch(...Array.from({ length: 10 }, () => reply));
    const c = new SandboxApiClient('http://cp', () => 't', fetch);
    await c.sandboxDiscovery();
    await c.listTemplates();
    await c.createSandbox({ template: 'node22' });
    await c.listSandboxes();
    await c.getSandbox('ID');
    await c.deleteSandbox('ID');
    await c.mintSandboxToken('ID');
    const seen = calls.map(
      (k) => `${k.method.toLowerCase()} ${new URL(k.url).pathname.replace('/ID', '/{id}')}`,
    );
    expect(new Set(seen)).toEqual(new Set(SBX_USED.map((u) => `${u.method} ${u.path}`)));
    // A new method on SandboxApiClient must be called above and listed in SBX_USED.
    const own = Object.getOwnPropertyNames(SandboxApiClient.prototype).filter(
      (m) => m !== 'constructor',
    );
    expect(new Set(own)).toEqual(
      new Set([
        'sandboxDiscovery',
        'listTemplates',
        'createSandbox',
        'listSandboxes',
        'getSandbox',
        'deleteSandbox',
        'mintSandboxToken',
      ]),
    );
  });
});

describe('turn-stream contract (harness/src/turn-stream.ts)', () => {
  it('the frame types match the harness TurnStreamFrame union', () => {
    const src = readFileSync(new URL('harness/src/turn-stream.ts', root), 'utf8');
    const union = src.slice(
      src.indexOf('export type TurnStreamFrame'),
      src.indexOf(';\n\n', src.indexOf('export type TurnStreamFrame')),
    );
    const types = [...union.matchAll(/type: '(\w+)'/g)].map((m) => m[1]);
    expect(new Set(types)).toEqual(new Set(KNOWN_FRAME_TYPES));
  });

  it('parses the recorded fixture into the expected frame sequence', async () => {
    // The harness ends every frame with a blank line; the end-of-file-fixer hook trims the file's
    // last one, and readSse (per the SSE spec) drops an unterminated block, so restore it here.
    const text =
      readFileSync(new URL('./fixtures/turn-stream.sse', import.meta.url), 'utf8').trimEnd() +
      '\n\n';
    const types = [];
    for await (const e of readSse(streamOf([text]))) types.push(toFrame(e).type);
    expect(types).toEqual(['thinking', 'text', 'text', 'tool_use', 'tool_result', 'text', 'done']);
  });
});
