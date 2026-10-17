import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { UnavailableCredentialStore, type CredentialStore } from '../src/credential-store.js';
import { configFromEnv, depsFromEnv } from '../src/main.js';
import { RedisSandboxStore } from '../src/sandbox-redis.js';
import { parseTemplates, routeProfileFromEnv } from '../src/sandbox-config.js';

const KEY = generateKeyPairSync('ed25519')
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();
const TEMPLATES = JSON.stringify([
  {
    id: 'default',
    worker: 'sbx_default',
    description: 'bash, git, Python 3',
    tools: ['bash', 'git', 'python3'],
  },
  { id: 'node22', worker: 'sbx_node22', description: 'Node 22', tools: ['node'] },
]);
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  SH_ROUTE_PROFILE: 'sandbox',
  SH_SESSION_TOKEN_PRIVATE_KEY: KEY,
  SH_GITHUB_CLIENT_ID: 'Iv1.test',
  SH_ALLOWED_SUBJECTS: 'github:1, github:2',
  SH_SANDBOX_TEMPLATES: TEMPLATES,
  SH_SANDBOX_EXEC_ENDPOINT: 'sbx-exec.apps.example.invalid:443',
  ...over,
});

/** The message a boot refusal throws, so a test can check what it names and what it does not echo. */
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected a throw');
};

describe('the sandbox profile config (SBX0 §4.1, §5)', () => {
  it('boots with no credential store, KEK, exchange token or inference settings', () => {
    const c = configFromEnv(env());
    expect(c.routeProfile).toBe('sandbox');
    expect(c.sandbox).toMatchObject({
      allowedSubjects: ['github:1', 'github:2'],
      lifetimeS: 604_800,
      retentionS: 1_209_600,
      tokenTtlS: 900,
      maxPerSubject: 3,
      maxTotal: 40,
      issuer: 'sbx-control-plane',
      execEndpoint: 'sbx-exec.apps.example.invalid:443',
    });
    expect(c.sandbox!.templates.map((t) => t.worker)).toEqual(['sbx_default', 'sbx_node22']);
  });

  it('refuses to boot without an allow list, templates or an exec endpoint', () => {
    expect(() => configFromEnv(env({ SH_ALLOWED_SUBJECTS: '' }))).toThrow(/SH_ALLOWED_SUBJECTS/);
    expect(() => configFromEnv(env({ SH_SANDBOX_TEMPLATES: undefined }))).toThrow(
      /SH_SANDBOX_TEMPLATES/,
    );
    expect(() => configFromEnv(env({ SH_SANDBOX_EXEC_ENDPOINT: 'https://x' }))).toThrow(
      /host:port/,
    );
  });

  it('refuses a short janitor token, and a lifetime that is not a positive integer', () => {
    expect(() => configFromEnv(env({ SH_JANITOR_TOKEN: 'short' }))).toThrow(/SH_JANITOR_TOKEN/);
    expect(() => configFromEnv(env({ SH_SANDBOX_LIFETIME_SECONDS: '-1' }))).toThrow(
      /SH_SANDBOX_LIFETIME_SECONDS/,
    );
  });

  it('names the variable in a refusal, never its value', () => {
    // A refusal lands in a pod log; a mistyped secret must not ride along with it.
    const short = 'janitor-secret-too-short'; // notsecret
    expect(messageOf(() => configFromEnv(env({ SH_JANITOR_TOKEN: short })))).not.toContain(short);
    expect(messageOf(() => configFromEnv(env({ SH_SANDBOX_MAX_TOTAL: '4x0' })))).not.toContain(
      '4x0',
    );
  });

  it('keeps the harness profile the default, and refuses an unknown one', () => {
    expect(routeProfileFromEnv({})).toBe('harness');
    expect(() => routeProfileFromEnv({ SH_ROUTE_PROFILE: 'sandboxes' })).toThrow(
      /SH_ROUTE_PROFILE/,
    );
  });

  it('reads an empty profile as harness, and refuses a near-miss at boot without echoing it', () => {
    // A typo would otherwise unmount every route, /healthz included: a pod that 404s its probes.
    expect(routeProfileFromEnv({ SH_ROUTE_PROFILE: '' })).toBe('harness');
    expect(routeProfileFromEnv({ SH_ROUTE_PROFILE: 'harness' })).toBe('harness');
    expect(routeProfileFromEnv({ SH_ROUTE_PROFILE: 'sandbox' })).toBe('sandbox');
    for (const v of ['Sandbox', ' sandbox', 'sandbox ', 'HARNESS', 'sbx-typo-value']) {
      const msg = messageOf(() => routeProfileFromEnv({ SH_ROUTE_PROFILE: v }));
      expect(msg, v).toMatch(/SH_ROUTE_PROFILE/);
      expect(msg, v).not.toContain(v);
    }
    // ...and configFromEnv applies it, before any harness-only setting is demanded.
    expect(() => configFromEnv(env({ SH_ROUTE_PROFILE: 'Sandbox' }))).toThrow(/SH_ROUTE_PROFILE/);
  });

  it('validates templates: ids, worker ids, uniqueness, shape', () => {
    expect(() => parseTemplates('not json')).toThrow(/JSON/);
    expect(() => parseTemplates('[]')).toThrow(/at least one/);
    expect(() =>
      parseTemplates(JSON.stringify([{ id: 'Bad', worker: 'w', description: '', tools: [] }])),
    ).toThrow(/id/);
    expect(() =>
      parseTemplates(JSON.stringify([{ id: 'a', worker: 'sbx-dash', description: '', tools: [] }])),
    ).toThrow(/worker/);
    expect(() =>
      parseTemplates(JSON.stringify([{ id: 'a', worker: 'DIR', description: '', tools: [] }])),
    ).toThrow(/worker/);
    expect(() =>
      parseTemplates(
        JSON.stringify([
          { id: 'a', worker: 'w1', description: '', tools: [] },
          { id: 'a', worker: 'w2', description: '', tools: [] },
        ]),
      ),
    ).toThrow(/twice/);
    expect(() =>
      parseTemplates(JSON.stringify([{ id: 'a', worker: 'w', description: 3, tools: [] }])),
    ).toThrow(/description/);
    expect(() =>
      parseTemplates(
        JSON.stringify([{ id: 'a', worker: 'w', description: '', tools: ['git', 'bash', 'git'] }]),
      ),
    ).toThrow(/tools must not list a tool twice/);
  });

  it('refuses an allow-list entry that is not a github:<numeric id> subject, without echoing it', () => {
    // The control plane mints `github:<id>`; a login-form or typo'd entry would never match.
    for (const v of ['octocat', 'github:octocat', 'gitlab:12', 'github:12x']) {
      const msg = messageOf(() => configFromEnv(env({ SH_ALLOWED_SUBJECTS: `github:1, ${v}` })));
      expect(msg, v).toMatch(/SH_ALLOWED_SUBJECTS/);
      expect(msg, v).not.toContain(v);
    }
    // A bare prefix is refused too (the message names the form, so it cannot be checked for echo).
    expect(() => configFromEnv(env({ SH_ALLOWED_SUBJECTS: 'github:' }))).toThrow(
      /SH_ALLOWED_SUBJECTS/,
    );
  });

  it('refuses an exec endpoint port outside 1-65535, without echoing the value', () => {
    for (const v of ['h.example.invalid:0', 'h.example.invalid:65536', 'h.example.invalid:99999']) {
      const msg = messageOf(() => configFromEnv(env({ SH_SANDBOX_EXEC_ENDPOINT: v })));
      expect(msg, v).toMatch(/SH_SANDBOX_EXEC_ENDPOINT/);
      expect(msg, v).not.toContain(v);
    }
    expect(
      configFromEnv(env({ SH_SANDBOX_EXEC_ENDPOINT: 'h.example.invalid:1' })).sandbox!.execEndpoint,
    ).toBe('h.example.invalid:1');
    expect(
      configFromEnv(env({ SH_SANDBOX_EXEC_ENDPOINT: 'h.example.invalid:65535' })).sandbox!
        .execEndpoint,
    ).toBe('h.example.invalid:65535');
  });

  it('refuses an exec CA that is not a PEM certificate, without echoing it', () => {
    const bad = 'not-a-certificate-value';
    const msg = messageOf(() => configFromEnv(env({ SH_SANDBOX_EXEC_CA: bad })));
    expect(msg).toMatch(/SH_SANDBOX_EXEC_CA/);
    expect(msg).not.toContain(bad);
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    expect(configFromEnv(env({ SH_SANDBOX_EXEC_CA: pem })).sandbox!.execCa).toBe(pem);
    expect(configFromEnv(env({ SH_SANDBOX_EXEC_CA: '' })).sandbox).not.toHaveProperty('execCa');
  });
});

describe('the sandbox profile deps (SBX0 §4.1)', () => {
  it('wires a refusing credential store and the Redis sandbox store', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Port 1: nothing listens, and nothing here issues a Redis command.
    const deps = depsFromEnv(env({ REDIS_URL: 'redis://127.0.0.1:1' }));
    try {
      expect(deps.credentials).toBeInstanceOf(UnavailableCredentialStore);
      expect(deps.sandboxes).toBeInstanceOf(RedisSandboxStore);
    } finally {
      await deps.close?.();
      errors.mockRestore();
    }
  });

  it('fails closed on every credential call, rather than answering "no credentials"', async () => {
    const s: CredentialStore = new UnavailableCredentialStore();
    const calls: (() => Promise<unknown>)[] = [
      () => s.put('github:1', {} as never),
      () => s.get('github:1', 'x'),
      () => s.list('github:1'),
      () => s.delete('github:1', 'x'),
    ];
    for (const call of calls)
      await expect(call()).rejects.toMatchObject({ code: 'internal_error' });
  });
});
