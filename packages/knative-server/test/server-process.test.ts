import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AMBIENT_KEY_SENTINEL } from '@moca/harness/ambient-sentinel';
import { isTenancyNearMiss, readTenancy } from '../src/tenancy.js';
import { prepareServerProcess, scrubAmbientCredentials } from '../src/server-process.js';
import { buildConfig } from '../src/server.js';

const KEYS = [
  'MOCA_TENANCY',
  'SH_REQUIRE_AUTH',
  'SH_LOCAL_TOOLS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'SH_SESSION_TOKEN_PUBLIC_KEYS',
  'PI_CODING_AGENT_DIR',
];

describe('readTenancy', () => {
  it('defaults to single and accepts the two values', () => {
    expect(readTenancy({})).toBe('single');
    expect(readTenancy({ MOCA_TENANCY: 'single' })).toBe('single');
    expect(readTenancy({ MOCA_TENANCY: 'multi' })).toBe('multi');
  });

  it('refuses anything else, naming the variable', () => {
    expect(() => readTenancy({ MOCA_TENANCY: 'Multi' })).toThrow(/MOCA_TENANCY/);
    expect(() => readTenancy({ MOCA_TENANCY: '' })).toThrow(/MOCA_TENANCY/);
  });

  it('refuses a misspelled variable name rather than reading it as unset (PR #350 review)', () => {
    const nearMisses = [
      'MOCA_TENANCY_MODE',
      'moca_tenancy',
      'MOCATENANCY',
      'MOCA_TENANCE',
      'SH_TENANCY',
      'TENANCY',
      'KAGENTI_TENANCY',
      'MOCA_TENENCY',
      'MOCA_TENNANCY',
      'MOCA_TENACY',
      'MOCA__TENANCY',
      'MOCA-TENANCY',
      ' MOCA_TENANCY',
      'MOCA_TENANCY_OLD',
      'MULTI_TENANCY',
      'MOCA_MULTI_TENANCY',
      'MOCA_MULTITENANCY',
      'SH_MOCA_TENANCY',
      'SH_KAGENTI_TENANCY',
      // Round 3: the TENAN... family after a leading word.
      'MOCA_TENANCIES',
      'MOCA_TENANT',
      'MOCA_MULTI_TENANT',
      'MOCA_MULTITENANT',
      'SH_MULTI_TENANT',
      'SH_TENANT',
      'KAGENTI_TENANT_MODE',
      'MOCATENANT',
    ];
    for (const name of nearMisses) {
      expect(isTenancyNearMiss(name), name).toBe(true);
      expect(() => readTenancy({ [name]: 'multi' }), name).toThrow(
        `unrecognised variable '${name}'`,
      );
    }
  });

  it('leaves the real name and unrelated variables alone', () => {
    for (const name of [
      'MOCA_TENANCY',
      'TENANT',
      'TENANT_ID',
      'MOCA_RELAY_EXEC_TOKEN',
      'SH',
      'MOCA',
      // Another product's variable, and an English word that contains the letters.
      'OCI_CLI_TENANCY',
      'MAINTENANCE_MODE',
      // Kubernetes service links for a Service named `tenancy` or `moca-tenancy`.
      'TENANCY_SERVICE_HOST',
      'TENANCY_SERVICE_PORT',
      'MOCA_TENANCY_PORT',
      'MOCA_TENANCY_SERVICE_HOST',
      'MOCA_TENANCY_SERVICE_PORT_HTTP',
      'MOCA_TENANCY_PORT_8080_TCP',
      'MOCA_TENANCY_PORT_8080_TCP_ADDR',
    ]) {
      expect(isTenancyNearMiss(name), name).toBe(false);
    }
    expect(readTenancy({ MOCA_TENANCY: 'multi', TENANT: 'acme', MOCA_RELAY_EXEC_TOKEN: 'x' })).toBe(
      'multi',
    );
  });

  it('answers a pathological name in linear time (js/polynomial-redos)', () => {
    // The service-link exemption once tested `SERVICE_PORT(_[A-Z0-9_]+)?$`, whose trailing class
    // matches `_SERVICE_PORT` itself -- so a name repeating that literal gave the engine
    // quadratically many ways to split it. This input took 7 s before the fix. The budget is
    // deliberately loose: it has to separate linear from quadratic, not time the machine.
    const pathological = '_SERVICE_PORT'.repeat(20_000) + '!';
    const started = performance.now();
    expect(isTenancyNearMiss(pathological)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('flags no environment variable name used anywhere in this repository', () => {
    // A false positive is a crashloop on a correctly configured deployment. Every name this repo
    // sets, reads or documents is fixed input here; only the deliberate test fixtures above match.
    const names = execFileSync(
      'git',
      [
        'grep',
        '-ohE',
        '[A-Z][A-Z0-9_]{3,}',
        '--',
        ':(top)',
        ':(top,exclude)pnpm-lock.yaml',
        // The implementation moved to @moca/control-plane (#387); its doc comment names the
        // near-misses the rule refuses, so it is excluded here as it always was.
        ':(top,exclude)packages/control-plane/src/tenancy.ts',
        // Boot test fixture: deliberately names a misspelled variable to assert it is refused.
        ':(top,exclude)packages/control-plane/test/main.test.ts',
        ':(top,exclude)packages/knative-server/test/server-process.test.ts',
        // Names near-misses on purpose, to document the rule.
        ':(top,exclude)docs/specs/2026-09-28-moca-multi-user-isolation-design.md',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
      .split('\n')
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(500);
    expect([...new Set(names)].filter(isTenancyNearMiss)).toEqual([]);
  });
});

describe('prepareServerProcess', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('under single tenancy leaves an operator key in place', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-operator' }; // notsecret
    expect(prepareServerProcess(env).tenancy).toBe('single');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-operator'); // notsecret
  });

  it('under multi tenancy replaces the key with the sentinel and deletes the rest', () => {
    const env: NodeJS.ProcessEnv = {
      MOCA_TENANCY: 'multi',
      SH_REQUIRE_AUTH: 'true',
      ANTHROPIC_API_KEY: 'sk-tenant-planted', // notsecret
      ANTHROPIC_OAUTH_TOKEN: 'oauth-planted', // notsecret
      ANTHROPIC_AUTH_TOKEN: 'auth-planted', // notsecret
      OPENAI_API_KEY: 'sk-openai-planted', // notsecret
    };
    prepareServerProcess(env);
    expect(env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
    // ANTHROPIC_OAUTH_TOKEN outranks ANTHROPIC_API_KEY in pi's lookup, so the sentinel alone would
    // not be enough: asserting its absence is the point (P5 §3.2 step 3).
    expect(env).not.toHaveProperty('ANTHROPIC_OAUTH_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('under multi tenancy refuses SH_LOCAL_TOOLS=1', () => {
    expect(() =>
      prepareServerProcess({ MOCA_TENANCY: 'multi', SH_REQUIRE_AUTH: 'true', SH_LOCAL_TOOLS: '1' }),
    ).toThrow(/SH_LOCAL_TOOLS/);
  });

  it('under multi tenancy refuses to run without SH_REQUIRE_AUTH=true', () => {
    expect(() => prepareServerProcess({ MOCA_TENANCY: 'multi' })).toThrow(/SH_REQUIRE_AUTH/);
  });

  it('still refuses a malformed session-token keyset, as startServer always has', () => {
    expect(() => prepareServerProcess({ SH_SESSION_TOKEN_PUBLIC_KEYS: 'garbage' })).toThrow(
      /SH_SESSION_TOKEN_PUBLIC_KEYS/,
    );
  });

  it('refuses at boot an exchange token set both as a systemd credential and in the env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-ks-creds-'));
    writeFileSync(join(dir, 'SH_EXCHANGE_TOKEN'), 'from-credential\n'); // notsecret
    const env: NodeJS.ProcessEnv = { CREDENTIALS_DIRECTORY: dir, SH_EXCHANGE_TOKEN: 'stale' }; // notsecret
    expect(() => prepareServerProcess(env)).toThrow(
      /both in the environment and as a systemd credential/,
    );
  });

  it('refuses at boot an empty exchange-token credential', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-ks-creds-'));
    writeFileSync(join(dir, 'SH_EXCHANGE_TOKEN'), '');
    expect(() => prepareServerProcess({ CREDENTIALS_DIRECTORY: dir })).toThrow(/is empty/);
  });

  it("scrubAmbientCredentials removes every credential pi's provider lookup reads (drift guard)", () => {
    // Every environment name pi-ai's env-api-keys.ts mentions, read from its source, so a provider
    // pi adds later is planted here without this test changing. Only project/location settings,
    // which authenticate nothing, may survive.
    const src = readFileSync(
      fileURLToPath(new URL('../../../pi-fork/packages/ai/src/env-api-keys.ts', import.meta.url)),
      'utf8',
    );
    const names = new Set(
      [...src.matchAll(/"([A-Z][A-Z0-9_]{2,})"|process\.env\.([A-Z][A-Z0-9_]+)/g)].map(
        (m) => m[1] ?? m[2],
      ),
    );
    // Sensitivity: the extraction must see pi's known lookups, or this checks nothing.
    for (const known of [
      'GEMINI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'HF_TOKEN',
      'ANTHROPIC_OAUTH_TOKEN',
    ])
      expect(names, known).toContain(known);
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', REDIS_URL: 'redis://r:6379' };
    for (const n of names) env[n] = 'planted';
    scrubAmbientCredentials(env);
    const NOT_CREDENTIALS = ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'];
    const survivors = Object.keys(env).filter(
      (k) => env[k] === 'planted' && !NOT_CREDENTIALS.includes(k),
    );
    expect(survivors).toEqual([]);
    expect(env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
    // Unrelated settings are untouched.
    expect(env.PATH).toBe('/usr/bin');
    expect(env.REDIS_URL).toBe('redis://r:6379');
  });

  it('scrubAmbientCredentials is idempotent', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-x' }; // notsecret
    scrubAmbientCredentials(env);
    scrubAmbientCredentials(env);
    expect(env.ANTHROPIC_API_KEY).toBe(AMBIENT_KEY_SENTINEL);
  });
});

describe('buildConfig marks every server turn (MI1 R3)', () => {
  it('sets serverMode on both the authenticated and the ambient branch', () => {
    expect(buildConfig(null).serverMode).toBe(true);
    expect(
      buildConfig({
        sessionId: 's',
        subject: 'github:1',
        anthropicBaseUrl: 'https://gw/v1',
        credential: { mode: 'direct', value: 'x' }, // notsecret
      } as never).serverMode,
    ).toBe(true);
  });

  it('allows local tools only when SH_LOCAL_TOOLS=1', () => {
    const saved = process.env.SH_LOCAL_TOOLS;
    try {
      delete process.env.SH_LOCAL_TOOLS;
      expect(buildConfig(null).allowLocalTools).toBe(false);
      process.env.SH_LOCAL_TOOLS = '1';
      expect(buildConfig(null).allowLocalTools).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SH_LOCAL_TOOLS;
      else process.env.SH_LOCAL_TOOLS = saved;
    }
  });

  it('passes the session tier through to the turn (P6.3)', () => {
    const auth = {
      subject: 'github:1',
      sessionId: 's',
      credential: { mode: 'direct' as const, value: 'k' }, // notsecret
      anthropicBaseUrl: 'https://x',
      sandboxTier: 'microvm',
    };
    expect(buildConfig(auth).sandboxTier).toBe('microvm');
    expect(buildConfig(null).sandboxTier).toBeUndefined();
  });

  it('passes the session template and its seed (session-templates spec §3.4)', () => {
    const auth = {
      subject: 'github:1',
      sessionId: 's',
      credential: { mode: 'direct' as const, value: 'k' }, // notsecret
      anthropicBaseUrl: 'https://x',
      sandboxTemplate: 'py312',
      sandboxSeed: 'echo hi',
      sandboxSeedSource: 'build' as const,
    };
    expect(buildConfig(auth).sandboxTemplate).toBe('py312');
    expect(buildConfig(auth).sandboxSeed).toBe('echo hi');
    expect(buildConfig(auth).sandboxSeedSource).toBe('build');
    expect(buildConfig(null).sandboxTemplate).toBeUndefined();
  });

  it('passes the session model as sessionModel, never as model (per-session model spec §5.1)', () => {
    const auth = {
      subject: 'github:1',
      sessionId: 's',
      credential: { mode: 'direct' as const, value: 'k' }, // notsecret
      anthropicBaseUrl: 'https://x',
      model: { id: 'granite-4.1-8b', contextWindow: 131072 },
    };
    const config = buildConfig(auth);
    expect(config.sessionModel).toEqual({ id: 'granite-4.1-8b', contextWindow: 131072 });
    expect(config.model).toBeUndefined();
    expect(buildConfig(null).sessionModel).toBeUndefined();
  });
});

describe('prepareServerProcess gives the process a private agent directory (MI1 R4)', () => {
  it('points PI_CODING_AGENT_DIR at an empty 0700 directory outside $HOME', () => {
    const env: NodeJS.ProcessEnv = {};
    const { agentDir } = prepareServerProcess(env);
    expect(env.PI_CODING_AGENT_DIR).toBe(agentDir);
    expect(existsSync(agentDir)).toBe(true);
    expect(readdirSync(agentDir)).toEqual([]);
    expect(statSync(agentDir).mode & 0o777).toBe(0o700);
    expect(agentDir.startsWith(`${homedir()}/.pi`)).toBe(false);
  });

  it('overrides an inherited PI_CODING_AGENT_DIR, and is stable within one process', () => {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: `${homedir()}/.pi/agent` };
    const first = prepareServerProcess(env).agentDir;
    const second = prepareServerProcess({}).agentDir;
    expect(env.PI_CODING_AGENT_DIR).toBe(first);
    expect(second).toBe(first);
  });
});
