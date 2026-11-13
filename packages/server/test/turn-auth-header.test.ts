import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyIdFor, makeSigner, type CpError } from '@moca/control-plane';
import { resolveTurnAuth, type TurnAuthDeps } from '../src/turn-auth.js';

/** #368: the exchange's authHeader reaches UpstreamCredential.header, and nothing else does. */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const NOW_S = 1_757_000_000;
const TOKEN = signer.mint({
  sub: 'github:1234',
  tenant: 'github:1234',
  roles: [],
  scope: ['turn:write'],
  sid: 'sid-1',
  ttlSeconds: 300,
  now: NOW_S,
});

const deps = (extra: Record<string, unknown>): TurnAuthDeps => ({
  keys: new Map([[keyIdFor(publicKey), publicKey]]),
  requireAuth: true,
  controlPlaneUrl: 'http://cp.default.svc:8080',
  exchangeToken: 'shared-abc', // notsecret
  now: () => NOW_S * 1000,
  fetchImpl: (async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({
        mode: 'direct',
        anthropicAuthToken: 'sk-ant-api03-x', // notsecret
        anthropicBaseUrl: 'https://api.anthropic.com',
        sessionId: 'sid-1',
        subject: 'github:1234',
        ...extra,
      }),
  })) as unknown as typeof fetch,
});

const auth = (extra: Record<string, unknown>) =>
  resolveTurnAuth({ authorization: `Bearer ${TOKEN}` }, { sessionId: 'sid-1' }, deps(extra));

describe('resolveTurnAuth: the credential header', () => {
  it("threads authHeader 'x-api-key' into the upstream credential", async () => {
    expect((await auth({ authHeader: 'x-api-key' }))?.credential).toEqual({
      mode: 'direct',
      value: 'sk-ant-api03-x', // notsecret
      header: 'x-api-key',
    });
  });

  it('adds no header field when the control plane omits authHeader (pre-#368 control plane)', async () => {
    expect((await auth({}))?.credential).toEqual({ mode: 'direct', value: 'sk-ant-api03-x' }); // notsecret
  });

  it("treats an explicit 'authorization' like an absent one", async () => {
    expect((await auth({ authHeader: 'authorization' }))?.credential).toEqual({
      mode: 'direct',
      value: 'sk-ant-api03-x', // notsecret
    });
  });

  it('refuses an unknown header as credential_unavailable rather than guessing', async () => {
    let code = '';
    try {
      await auth({ authHeader: 'x-custom' });
    } catch (e) {
      code = (e as CpError).code;
    }
    expect(code).toBe('credential_unavailable');
  });
});
