import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCredentialStore } from '../src/file-store.js';
import { describe, expect, it, vi } from 'vitest';
import { UnavailableCredentialStore, type CredentialStore } from '../src/credential-store.js';
import { configFromEnv, depsFromEnv } from '../src/main.js';
import { RedisSandboxStore } from '../src/sandbox-redis.js';
import {
  isEnrolled,
  isEnrolledForSandbox,
  parseTemplates,
  routeProfileFromEnv,
} from '../src/sandbox-config.js';
import { MEMBER_SUBJECT_RE } from '../src/identity.js';

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

describe('the combined profile config (combined control plane spec §3.5)', () => {
  const KEK = Buffer.alloc(32, 7).toString('base64'); // notsecret
  const harness = { SH_CREDENTIAL_KEK: KEK, SH_EXCHANGE_TOKEN: 'x'.repeat(32) }; // notsecret
  const cenv = (over: Record<string, string | undefined> = {}) =>
    env({ SH_ROUTE_PROFILE: 'combined', ...harness, ...over });

  it("boots with both profiles' settings: the sandbox block and the harness fields", () => {
    const c = configFromEnv(cenv({ SH_PUBLIC_HARNESS_URL: 'https://h.example.invalid' }));
    expect(c.routeProfile).toBe('combined');
    expect(c.sandbox?.allowedSubjects).toEqual(['github:1', 'github:2']);
    expect(c.sandbox?.execEndpoint).toBe('sbx-exec.apps.example.invalid:443');
    expect(c.exchangeToken).toBe('x'.repeat(32));
    expect(c.publicHarnessUrl).toBe('https://h.example.invalid');
    // One template list for sessions and sandboxes.
    expect(c.sessionTemplates?.map((t) => t.id)).toEqual(['default', 'node22']);
    expect(c.sandbox?.templates.map((t) => t.id)).toEqual(['default', 'node22']);
  });

  // ADR-0045 + `mocactl sbx login --test-user N`: SH_ALLOWED_SUBJECTS validates with SUBJECT_RE,
  // which admits `test:<n>` -- so an operator CAN enrol a test user on a combined dev stack on
  // purpose. Pinned because a test-user login reaches a sandbox only this way (or via
  // SH_ADMIN_SUBJECTS), and because `/v1/subjects` refuses the same subject (MEMBER_SUBJECT_RE).
  it('admits a test subject on the allow list, which the subjects API does not', () => {
    // Also the one assertion that `combined` BOOTS with test users: only `sandbox` refuses to.
    const c = configFromEnv(
      cenv({
        SH_ALLOWED_SUBJECTS: 'github:1, test:7',
        SH_TEST_USERS: '10',
        SH_TEST_USER_SECRET: 's'.repeat(32), // notsecret
      }),
    );
    expect(c.sandbox?.allowedSubjects).toEqual(['github:1', 'test:7']);
    expect(MEMBER_SUBJECT_RE.test('test:7')).toBe(false);
  });

  it('reads the installer bearer, as the sandbox profile does (#938)', () => {
    expect(configFromEnv(cenv()).installerToken).toBeUndefined();
    expect(configFromEnv(cenv({ SH_INSTALLER_TOKEN: 'i'.repeat(32) })).installerToken).toBe(
      'i'.repeat(32),
    ); // notsecret
    expect(messageOf(() => configFromEnv(cenv({ SH_INSTALLER_TOKEN: 'short' })))).toContain(
      'SH_INSTALLER_TOKEN must be at least 32 characters',
    );
  });

  it("refuses to boot without either profile's required settings, naming the missing one", () => {
    for (const name of [
      'SH_CREDENTIAL_KEK',
      'SH_EXCHANGE_TOKEN',
      'SH_ALLOWED_SUBJECTS',
      'SH_SANDBOX_EXEC_ENDPOINT',
      'SH_SANDBOX_TEMPLATES',
    ]) {
      expect(messageOf(() => configFromEnv(cenv({ [name]: undefined })))).toContain(name);
    }
  });

  // SH_SANDBOX_TEST_USERS_ENROLLED: the one setting that enrols test:1..N for the sandbox routes
  // without naming each on the allow list (ADR-0045 range-checks rather than pre-minting).
  it('reads SH_SANDBOX_TEST_USERS_ENROLLED as exactly "true", and defaults it off', () => {
    const users = { SH_TEST_USERS: '1000', SH_TEST_USER_SECRET: 's'.repeat(32) }; // notsecret
    expect(configFromEnv(cenv(users)).sandbox!.testUsersEnrolled).toBe(false);
    expect(
      configFromEnv(cenv({ ...users, SH_SANDBOX_TEST_USERS_ENROLLED: 'true' })).sandbox!
        .testUsersEnrolled,
    ).toBe(true);
    // A near miss must not enrol a thousand subjects, as SH_ALLOW_OPERATOR_FALLBACK (main.ts).
    for (const v of ['1', 'TRUE', 'yes', 'True', ' true']) {
      expect(
        configFromEnv(cenv({ ...users, SH_SANDBOX_TEST_USERS_ENROLLED: v })).sandbox!
          .testUsersEnrolled,
        v,
      ).toBe(false);
    }
  });

  it('refuses to boot when the test-user range is enrolled but no test user can log in', () => {
    const msg = messageOf(() => configFromEnv(cenv({ SH_SANDBOX_TEST_USERS_ENROLLED: 'true' })));
    expect(msg).toContain('SH_SANDBOX_TEST_USERS_ENROLLED');
    expect(msg).toContain('SH_TEST_USERS');
    // With the logins on, the same settings boot.
    expect(
      configFromEnv(
        cenv({
          SH_SANDBOX_TEST_USERS_ENROLLED: 'true',
          SH_TEST_USERS: '1000',
          SH_TEST_USER_SECRET: 's'.repeat(32), // notsecret
        }),
      ).sandbox!.testUsersEnrolled,
    ).toBe(true);
  });

  it('builds the sandbox store and keeps the harness credential store', () => {
    const d = depsFromEnv(
      cenv({
        REDIS_URL: 'redis://127.0.0.1:1',
        SH_CREDENTIAL_STORE: 'file',
        SH_CREDENTIAL_DIR: mkdtempSync(join(tmpdir(), 'cp-comb-')),
      }),
    );
    expect(d.sandboxes).toBeInstanceOf(RedisSandboxStore);
    expect(d.credentials).not.toBeInstanceOf(UnavailableCredentialStore);
    void d.close?.();
  });
});

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
    // Lease-mode policy (lease-mode spec §8.1, ruling R20): every lease mode stays off unless an
    // operator lists it, until the §11 lease section of the security review.
    expect([...c.sandbox!.modesAllowed].sort()).toEqual(['per-exec']);
    expect(c.sandbox!.idleCeilingS).toBe(1800);
  });

  it('defaults the maximum idle lifetime to the default lifetime, so an unset key offers nothing longer', () => {
    const c = configFromEnv(env()).sandbox!;
    expect(c.lifetimeS).toBe(7 * 86_400);
    expect(c.maxLifetimeS).toBe(7 * 86_400);
    const d = configFromEnv(env({ SH_SANDBOX_LIFETIME_SECONDS: '172800' })).sandbox!;
    expect(d.maxLifetimeS).toBe(172_800);
  });

  it('takes SH_SANDBOX_MAX_LIFETIME_SECONDS', () => {
    const c = configFromEnv(env({ SH_SANDBOX_MAX_LIFETIME_SECONDS: '1209600' })).sandbox!;
    expect(c.maxLifetimeS).toBe(1_209_600);
  });

  it('slides the deadline on activity only when SH_SANDBOX_MAX_LIFETIME_SECONDS is set', () => {
    expect(configFromEnv(env()).sandbox!.slideOnActivity).toBe(false);
    expect(
      configFromEnv(env({ SH_SANDBOX_MAX_LIFETIME_SECONDS: '' })).sandbox!.slideOnActivity,
    ).toBe(false);
    expect(
      configFromEnv(env({ SH_SANDBOX_MAX_LIFETIME_SECONDS: '1209600' })).sandbox!.slideOnActivity,
    ).toBe(true);
  });

  it('refuses a default above the maximum', () => {
    expect(() =>
      configFromEnv(
        env({ SH_SANDBOX_LIFETIME_SECONDS: '864000', SH_SANDBOX_MAX_LIFETIME_SECONDS: '432000' }),
      ),
    ).toThrow(/SH_SANDBOX_LIFETIME_SECONDS must be at most SH_SANDBOX_MAX_LIFETIME_SECONDS/);
  });

  it('refuses lifetimes under an hour', () => {
    expect(() => configFromEnv(env({ SH_SANDBOX_LIFETIME_SECONDS: '3599' }))).toThrow(
      /at least 3600/,
    );
    expect(() => configFromEnv(env({ SH_SANDBOX_MAX_LIFETIME_SECONDS: '3599' }))).toThrow(
      /at least 3600/,
    );
  });

  it('reads SH_SANDBOX_MODES_ALLOWED as a comma list, and an empty value as the default', () => {
    const modes = (v: string | undefined) =>
      [...configFromEnv(env({ SH_SANDBOX_MODES_ALLOWED: v })).sandbox!.modesAllowed].sort();
    expect(modes(' per-exec , lease , lease+processes ')).toEqual([
      'lease',
      'lease+processes',
      'per-exec',
    ]);
    expect(modes('per-exec')).toEqual(['per-exec']);
    expect(modes('lease,lease')).toEqual(['lease']);
    expect(modes('')).toEqual(['per-exec']);
    expect(modes(undefined)).toEqual(['per-exec']);
  });

  it('refuses an unknown or empty mode list at boot, without echoing it', () => {
    for (const v of ['per-exec,resident', 'Lease', 'lease processes', ' , ']) {
      const msg = messageOf(() => configFromEnv(env({ SH_SANDBOX_MODES_ALLOWED: v })));
      expect(msg, v).toMatch(/^SH_SANDBOX_MODES_ALLOWED/);
      if (v.trim().replace(/,/g, '') !== '') expect(msg, v).not.toContain(v);
    }
  });

  it('reads SH_SANDBOX_IDLE_CEILING_S as a positive integer', () => {
    expect(configFromEnv(env({ SH_SANDBOX_IDLE_CEILING_S: '3600' })).sandbox!.idleCeilingS).toBe(
      3600,
    );
    for (const v of ['0', '-5', '30s', '1.5']) {
      expect(() => configFromEnv(env({ SH_SANDBOX_IDLE_CEILING_S: v })), v).toThrow(
        /^SH_SANDBOX_IDLE_CEILING_S must be a positive integer/,
      );
    }
  });

  it('refuses an idle ceiling below the 30 s floor of an owner idle timeout (ruling R6)', () => {
    expect(configFromEnv(env({ SH_SANDBOX_IDLE_CEILING_S: '30' })).sandbox!.idleCeilingS).toBe(30);
    for (const v of ['1', '29']) {
      expect(() => configFromEnv(env({ SH_SANDBOX_IDLE_CEILING_S: v })), v).toThrow(
        /^SH_SANDBOX_IDLE_CEILING_S must be at least 30/,
      );
    }
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

  it('refuses a token TTL over an hour, which would stretch how late a delete takes effect', () => {
    expect(configFromEnv(env({ SH_SANDBOX_TOKEN_TTL_SECONDS: '3600' })).sandbox?.tokenTtlS).toBe(
      3600,
    );
    expect(() => configFromEnv(env({ SH_SANDBOX_TOKEN_TTL_SECONDS: '3601' }))).toThrow(
      /^SH_SANDBOX_TOKEN_TTL_SECONDS must be at most 3600/,
    );
  });

  it('reads SH_GATE_RECORD_SCHEMA: absent by default, set when given, refused when malformed', () => {
    expect(configFromEnv(env({})).sandbox).not.toHaveProperty('gateRecordSchema');
    expect(
      configFromEnv(env({ SH_GATE_RECORD_SCHEMA: 'builder.example/gate/1' })).sandbox
        ?.gateRecordSchema,
    ).toBe('builder.example/gate/1');
    expect(() => configFromEnv(env({ SH_GATE_RECORD_SCHEMA: 'a gate/1' }))).toThrow(
      /^SH_GATE_RECORD_SCHEMA must be a schema string/,
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

  it('reads the combined profile (combined control plane spec §3.5)', () => {
    expect(routeProfileFromEnv({ SH_ROUTE_PROFILE: 'combined' })).toBe('combined');
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

  it('wires the real credential store when egress is configured (SBX0.2b)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = depsFromEnv(
      env({
        REDIS_URL: 'redis://127.0.0.1:1',
        SH_EGRESS_HOSTS: '[{"id":"kvm","workers":["sbx_default"]}]',
        SH_CREDENTIAL_KEK: Buffer.alloc(32, 1).toString('base64'), // notsecret
        SH_EGRESS_TOKEN_KVM: 'a'.repeat(64), // notsecret
        SH_CREDENTIAL_STORE: 'file',
        SH_CREDENTIAL_DIR: mkdtempSync(join(tmpdir(), 'egress-cs-')),
      }),
    );
    try {
      expect(deps.credentials).toBeInstanceOf(FileCredentialStore);
    } finally {
      await deps.close?.();
      errors.mockRestore();
    }
  });

  describe('credential store on the sandbox profile with egress', () => {
    const egressEnv = (over: Record<string, string | undefined>) =>
      env({
        REDIS_URL: 'redis://127.0.0.1:1',
        SH_EGRESS_HOSTS: '[{"id":"kvm","workers":["sbx_default"]}]',
        SH_CREDENTIAL_KEK: Buffer.alloc(32, 1).toString('base64'), // notsecret
        SH_EGRESS_TOKEN_KVM: 'a'.repeat(64), // notsecret
        ...over,
      });
    const REFUSAL =
      'SH_CREDENTIAL_STORE must be file or vault on the sandbox profile with egress credentials (it has no Kubernetes API access)';

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['kubernetes', 'kubernetes'],
    ])('refuses at boot when SH_CREDENTIAL_STORE is %s', (_n, value) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => depsFromEnv(egressEnv({ SH_CREDENTIAL_STORE: value }))).toThrow(REFUSAL);
      } finally {
        errors.mockRestore();
      }
    });

    it('accepts file, and vault (only that the refusal does not fire; no vault call is made)', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dir = mkdtempSync(join(tmpdir(), 'egress-cs-'));
      try {
        const f = depsFromEnv(egressEnv({ SH_CREDENTIAL_STORE: 'file', SH_CREDENTIAL_DIR: dir }));
        await f.close?.();
        const v = depsFromEnv(
          egressEnv({
            SH_CREDENTIAL_STORE: 'vault',
            VAULT_ADDR: 'https://vault:8200',
            VAULT_TOKEN: 'tok', // notsecret
          }),
        );
        await v.close?.();
      } finally {
        errors.mockRestore();
      }
    });
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
