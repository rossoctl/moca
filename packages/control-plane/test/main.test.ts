import { generateKeyPairSync } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCredentialStore } from '../src/file-store.js';
import { formatEnvLines, generateMu1Secrets } from '../src/genkeys.js';
import { K8sSecretStore } from '../src/k8s-secret-store.js';
import { HANDLERS } from '../src/handlers.js';
import {
  configFromEnv,
  depsFromEnv,
  credentialStoreFromEnv,
  portFromEnv,
  verifyKeysFromEnv,
  CONTROL_PLANE_SECRETS,
  hostFromEnv,
} from '../src/main.js';
import { keyIdFor, makeSigner, parseKeyset, publicKeyToBase64, verifyToken } from '../src/token.js';
import { VaultCredentialStore } from '../src/vault-store.js';
import { withCredentials } from '../src/systemd-credentials.js';
import { codeOf, ctx } from './helpers/deps.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PRIVATE_PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const KEK = randomBytes(32).toString('base64'); // notsecret

const baseEnv = {
  SH_SESSION_TOKEN_PRIVATE_KEY: PRIVATE_PEM,
  SH_CREDENTIAL_KEK: KEK,
  SH_GITHUB_CLIENT_ID: 'Iv1.fake', // notsecret
  SH_EXCHANGE_TOKEN: 'shared-abc', // notsecret
} as NodeJS.ProcessEnv;

describe('portFromEnv', () => {
  it('defaults to 8080 and rejects nonsense rather than binding port NaN', () => {
    expect(portFromEnv({})).toBe(8080);
    expect(portFromEnv({ SH_CONTROL_PLANE_PORT: '9090' })).toBe(9090);
    expect(portFromEnv({ SH_CONTROL_PLANE_PORT: 'abc' })).toBe(8080);
    expect(portFromEnv({ SH_CONTROL_PLANE_PORT: '-1' })).toBe(8080);
  });
});

describe('configFromEnv', () => {
  it('uses the spec`s defaults', () => {
    const c = configFromEnv(baseEnv);
    expect(c.apiTokenTtlSeconds).toBe(3600);
    expect(c.sessionTokenTtlSeconds).toBe(300); // a session outlives a 5-minute token (spec §4.2)
    expect(c.allowOperatorFallback).toBe(false); // spec §6.4: default false
    expect(c.injectorConfigured).toBe(false);
    expect(c.sandboxNamespace).toBe('default');
  });

  it('reads the operator fallback only from an explicit true', () => {
    const on = {
      ...baseEnv,
      SH_OPERATOR_INFERENCE_TOKEN: 'op-gw', // notsecret
      SH_DEFAULT_INFERENCE_ENDPOINT: 'https://litellm.internal',
    };
    expect(configFromEnv({ ...on, SH_ALLOW_OPERATOR_FALLBACK: 'true' }).allowOperatorFallback).toBe(
      true,
    );
    for (const v of ['1', 'yes', 'TRUE', '', 'false']) {
      // Exactly 'true', because a typo must not silently switch on a fallback that lets one subject
      // spend the operator's key.
      expect(configFromEnv({ ...on, SH_ALLOW_OPERATOR_FALLBACK: v }).allowOperatorFallback, v).toBe(
        v === 'true',
      );
    }
  });

  it('carries the exchange token and the endpoints through', () => {
    const c = configFromEnv({
      ...baseEnv,
      SH_DEFAULT_INFERENCE_ENDPOINT: 'https://litellm/v1',
      SH_OPERATOR_INFERENCE_TOKEN: 'sk-op', // notsecret
      SH_INJECTOR_CONFIGURED: 'true',
      SH_SANDBOX_NAMESPACE: 'sandboxes',
    });
    expect(c).toMatchObject({
      exchangeToken: 'shared-abc', // notsecret
      defaultInferenceEndpoint: 'https://litellm/v1',
      operatorInferenceToken: 'sk-op', // notsecret
      injectorConfigured: true,
      sandboxNamespace: 'sandboxes',
    });
  });

  it('advertises SH_PUBLIC_HARNESS_URL without trailing slashes, and nothing when unset', () => {
    expect(configFromEnv(baseEnv).publicHarnessUrl).toBeUndefined();
    expect(
      configFromEnv({ ...baseEnv, SH_PUBLIC_HARNESS_URL: 'https://harness.example.com/' })
        .publicHarnessUrl,
    ).toBe('https://harness.example.com');
  });

  it('trims SH_PUBLIC_HARNESS_URL in one pass, even on a long run of slashes', () => {
    // The shape that made the old /\/+$/ quadratic (CodeQL js/polynomial-redos).
    const many = `https://h.example${'/'.repeat(100_000)}x`;
    expect(configFromEnv({ ...baseEnv, SH_PUBLIC_HARNESS_URL: many }).publicHarnessUrl).toBe(many);
    expect(
      configFromEnv({ ...baseEnv, SH_PUBLIC_HARNESS_URL: 'https://h.example///' }).publicHarnessUrl,
    ).toBe('https://h.example');
  });

  it('refuses to start with a SH_PUBLIC_HARNESS_URL no client could use', () => {
    for (const bad of ['harness.example.com', 'ftp://harness', 'not a url']) {
      expect(() => configFromEnv({ ...baseEnv, SH_PUBLIC_HARNESS_URL: bad }), bad).toThrow(
        /SH_PUBLIC_HARNESS_URL must be an absolute http\(s\) URL/,
      );
    }
  });
});

describe('verifyKeysFromEnv', () => {
  it('always includes the signer`s own public key', () => {
    const keys = verifyKeysFromEnv(baseEnv, publicKeyToBase64(publicKey));
    expect(keys.has(keyIdFor(publicKey))).toBe(true);
  });

  it('adds any extra published keys, so a rotation window verifies both', () => {
    const other = generateKeyPairSync('ed25519').publicKey;
    const keys = verifyKeysFromEnv(
      {
        ...baseEnv,
        SH_SESSION_TOKEN_PUBLIC_KEYS: `${keyIdFor(other)}:${publicKeyToBase64(other)}`,
      },
      publicKeyToBase64(publicKey),
    );
    expect(keys.size).toBe(2);
  });
});

describe('fail-fast on missing configuration', () => {
  it('refuses to start with no signing key, KEK, client id or exchange token', () => {
    for (const missing of [
      'SH_SESSION_TOKEN_PRIVATE_KEY',
      'SH_CREDENTIAL_KEK',
      'SH_GITHUB_CLIENT_ID',
      'SH_EXCHANGE_TOKEN',
    ]) {
      const env = { ...baseEnv };
      delete env[missing];
      // Fail at STARTUP, not on the first request: a control plane that boots without a KEK would
      // accept credential writes it cannot encrypt, and one without an exchange token would 401
      // every turn with a healthy-looking pod.
      expect(() => configFromEnv(env), missing).toThrow(new RegExp(missing));
    }
  });
});

describe('credentialStoreFromEnv (SH_CREDENTIAL_STORE)', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'cp-main-store-'));

  it('defaults to the Kubernetes store, so an existing deployment needs no new setting', () => {
    expect(credentialStoreFromEnv(baseEnv)).toBeInstanceOf(K8sSecretStore);
    expect(
      credentialStoreFromEnv({ ...baseEnv, SH_CREDENTIAL_STORE: 'kubernetes' }),
    ).toBeInstanceOf(K8sSecretStore);
  });

  it('selects the file store, which needs SH_CREDENTIAL_DIR', () => {
    expect(
      credentialStoreFromEnv({ ...baseEnv, SH_CREDENTIAL_STORE: 'file', SH_CREDENTIAL_DIR: dir() }),
    ).toBeInstanceOf(FileCredentialStore);
    expect(() => credentialStoreFromEnv({ ...baseEnv, SH_CREDENTIAL_STORE: 'file' })).toThrow(
      /SH_CREDENTIAL_DIR is required/,
    );
  });

  it('selects the Vault store, which needs VAULT_ADDR and a token', () => {
    const token = 'hvs.x'; // notsecret
    const vault = { ...baseEnv, SH_CREDENTIAL_STORE: 'vault', VAULT_ADDR: 'https://vault:8200' };
    expect(credentialStoreFromEnv({ ...vault, VAULT_TOKEN: token })).toBeInstanceOf(
      VaultCredentialStore,
    );
    expect(() => credentialStoreFromEnv(vault)).toThrow(/VAULT_TOKEN/);
    expect(() => credentialStoreFromEnv({ ...vault, VAULT_ADDR: '', VAULT_TOKEN: token })).toThrow(
      /VAULT_ADDR is required/,
    );
  });

  it('refuses an unknown store rather than falling back to the default', () => {
    for (const bad of ['vualt', 'k8s', 'File', 'redis']) {
      expect(() => credentialStoreFromEnv({ ...baseEnv, SH_CREDENTIAL_STORE: bad }), bad).toThrow(
        /SH_CREDENTIAL_STORE must be one of kubernetes, file, vault/,
      );
    }
  });

  it('refuses every store without a usable KEK', () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      SH_CREDENTIAL_STORE: 'file',
      SH_CREDENTIAL_DIR: dir(),
    };
    delete env.SH_CREDENTIAL_KEK;
    expect(() => credentialStoreFromEnv(env)).toThrow(/SH_CREDENTIAL_KEK/);
  });
});

describe('the signing key as one line of base64 PKCS#8 DER (env-file form)', () => {
  it('builds the same signer as the PEM, so either form can be deployed', () => {
    const der = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64');
    expect(makeSigner(der).kid).toBe(makeSigner(PRIVATE_PEM).kid);
    expect(makeSigner(der).kid).toBe(keyIdFor(publicKey));
  });

  it('still refuses a public key or garbage in the one-line form', () => {
    const spki = publicKeyToBase64(publicKey);
    expect(() => makeSigner(spki)).toThrow(/not a usable private key/);
    expect(() => makeSigner('not-base64-der')).toThrow(/not a usable private key/);
  });
});

describe('generateMu1Secrets (install.sh`s key generator)', () => {
  it('emits exactly the four secrets, each in the form its consumer parses', () => {
    const s = generateMu1Secrets();
    expect(Object.keys(s).sort()).toEqual([
      'SH_CREDENTIAL_KEK',
      'SH_EXCHANGE_TOKEN',
      'SH_SESSION_TOKEN_PRIVATE_KEY',
      'SH_SESSION_TOKEN_PUBLIC_KEYS',
    ]);
    // A control plane boots on them (with a client id, which is the operator's input) ...
    const env = { ...s, SH_GITHUB_CLIENT_ID: 'Iv1.fake' } as NodeJS.ProcessEnv; // notsecret
    expect(() => configFromEnv(env)).not.toThrow();
    // ... and the harness's published keyset verifies what that control plane mints.
    const signer = makeSigner(s.SH_SESSION_TOKEN_PRIVATE_KEY!);
    const token = signer.mint({
      sub: 'github:1',
      tenant: 't',
      roles: [],
      scope: ['api'],
      ttlSeconds: 60,
    });
    expect(verifyToken(token, parseKeyset(s.SH_SESSION_TOKEN_PUBLIC_KEYS)).sub).toBe('github:1');
    expect(s.SH_EXCHANGE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is single-line per secret, so each is one env-file assignment', () => {
    const lines = formatEnvLines(generateMu1Secrets()).split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(l).toMatch(/^SH_[A-Z_]+=[^\s]+$/);
  });

  it('is fresh every run', () => {
    const a = generateMu1Secrets();
    const b = generateMu1Secrets();
    for (const k of Object.keys(a)) expect(a[k], k).not.toBe(b[k]);
  });
});

describe('hostFromEnv (SH_CONTROL_PLANE_HOST)', () => {
  it('is unset by default, so every existing deployment keeps listening on all interfaces', () => {
    expect(hostFromEnv({})).toBeUndefined();
    expect(hostFromEnv({ SH_CONTROL_PLANE_HOST: '' })).toBeUndefined();
    expect(hostFromEnv({ SH_CONTROL_PLANE_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });
});

describe('the control plane`s secrets as systemd credentials (deploy/vm)', () => {
  it('names exactly the secrets main.ts reads, and nothing public', () => {
    expect([...CONTROL_PLANE_SECRETS].sort()).toEqual([
      'SH_CREDENTIAL_KEK',
      'SH_EXCHANGE_TOKEN',
      'SH_OPERATOR_INFERENCE_TOKEN',
      'SH_SESSION_TOKEN_PRIVATE_KEY',
    ]);
  });

  it('boots from credential files with none of the secrets in the environment', () => {
    const s = generateMu1Secrets();
    const dir = mkdtempSync(join(tmpdir(), 'sh-cp-creds-'));
    for (const n of ['SH_SESSION_TOKEN_PRIVATE_KEY', 'SH_CREDENTIAL_KEK', 'SH_EXCHANGE_TOKEN'])
      writeFileSync(join(dir, n), `${s[n]}\n`);
    const env = withCredentials(
      { CREDENTIALS_DIRECTORY: dir, SH_GITHUB_CLIENT_ID: 'Iv1.fake' }, // notsecret
      CONTROL_PLANE_SECRETS,
    );
    const cfg = configFromEnv(env);
    expect(cfg.exchangeToken).toBe(s.SH_EXCHANGE_TOKEN);
    // The signer built from the file verifies against the public half setup-vm.sh gives the supervisor.
    const signer = makeSigner(env.SH_SESSION_TOKEN_PRIVATE_KEY!);
    const token = signer.mint({
      sub: 'github:1',
      tenant: 't',
      roles: [],
      scope: ['api'],
      ttlSeconds: 60,
    });
    expect(verifyToken(token, parseKeyset(s.SH_SESSION_TOKEN_PUBLIC_KEYS)).sub).toBe('github:1');
  });
});

/** A port nothing listens on: bind an ephemeral one, read it, release it. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

describe('depsFromEnv against a Redis that starts AFTER the control plane (#423, spike finding F2)', () => {
  it('fails readyz fast, keeps reconnecting, and never logs the Redis password', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const port = await freePort();
    const deps = depsFromEnv({
      ...baseEnv,
      REDIS_URL: `redis://:topsecret@127.0.0.1:${port}`, // notsecret
    });
    let server: Server | undefined;
    const sockets = new Set<Socket>();
    try {
      // Raced against a timer, so the old behaviour -- a readyz parked in the offline queue -- fails
      // this assertion rather than hanging the suite.
      const started = Date.now();
      const code = await Promise.race([
        codeOf(() => HANDLERS.readyz!(ctx(), deps)),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 1000).unref()),
      ]);
      expect(code).toBe('redis_unavailable');
      expect(Date.now() - started).toBeLessThan(1000);
      expect(deps.redisReady?.()).toBe(false);

      // "Redis" comes up. It need not speak RESP: accepting and dropping every connection is enough
      // to count reconnect attempts, and two prove the client retries rather than giving up.
      let connections = 0;
      server = createServer((sock) => {
        connections++;
        sockets.add(sock);
        sock.destroy();
      });
      await new Promise<void>((resolve) => server!.listen(port, '127.0.0.1', resolve));
      await vi.waitFor(() => expect(connections).toBeGreaterThanOrEqual(2), {
        timeout: 5000,
        interval: 50,
      });

      const logged = errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).toContain('[control-plane] redis client error');
      expect(logged).not.toContain('topsecret');
    } finally {
      await deps.close?.();
      for (const s of sockets) s.destroy();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      errors.mockRestore();
    }
  });
});
