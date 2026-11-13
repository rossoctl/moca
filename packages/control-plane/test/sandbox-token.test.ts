import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeSigner, publicKeyFromBase64, verifyToken } from '../src/token.js';
import {
  DEFAULT_SANDBOX_ISSUER,
  SANDBOX_MODE_TOKEN_TTL_S,
  SANDBOX_MODE_TOKEN_TYP,
  SANDBOX_TOKEN_AUDIENCE,
  SANDBOX_TOKEN_TYP,
  mintSandboxToken,
  mintSetModeToken,
  verifySandboxToken,
  verifySetModeToken,
} from '../src/sandbox-token.js';

const NOW = 1_800_000_000;

function keys() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  const ring = new Map<string, KeyObject>([
    [signer.kid, publicKeyFromBase64(signer.publicKeyBase64)],
  ]);
  return { signer, ring };
}

const input = (over: Partial<Parameters<typeof mintSandboxToken>[1]> = {}) => ({
  sub: 'github:1',
  tenant: 'github:1',
  sbx: 'sbx-0123456789abcdef0123456789',
  wrk: 'sbx_default',
  wsk: 'sbx-0123456789abcdef0123456789',
  ttlSeconds: 900,
  notAfter: NOW + 7 * 86_400,
  iss: DEFAULT_SANDBOX_ISSUER,
  now: NOW,
  ...over,
});

const header = (t: string) => JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString());

describe('sandbox token (SBX0 §4.3)', () => {
  it('mints the pinned header and claims, verifiable with the public key only', () => {
    const { signer, ring } = keys();
    const { token, exp } = mintSandboxToken(signer, input());
    expect(header(token)).toEqual({ alg: 'EdDSA', typ: SANDBOX_TOKEN_TYP, kid: signer.kid });
    expect(exp).toBe(NOW + 900);
    const c = verifySandboxToken(token, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW + 1 });
    expect(c).toMatchObject({
      aud: SANDBOX_TOKEN_AUDIENCE,
      sub: 'github:1',
      sbx: 'sbx-0123456789abcdef0123456789',
      wrk: 'sbx_default',
      wsk: 'sbx-0123456789abcdef0123456789',
      scope: ['exec'],
      iat: NOW,
      exp: NOW + 900,
    });
    expect(typeof c.jti).toBe('string');
  });

  it('caps exp at the sandbox expiry, and refuses to mint for an ended sandbox', () => {
    const { signer } = keys();
    expect(mintSandboxToken(signer, input({ notAfter: NOW + 60 })).exp).toBe(NOW + 60);
    expect(() => mintSandboxToken(signer, input({ notAfter: NOW }))).toThrow(
      expect.objectContaining({ code: 'sandbox_terminated' }),
    );
  });

  it('accepts 30 s of clock skew past exp, and no more', () => {
    const { signer, ring } = keys();
    const { token } = mintSandboxToken(signer, input());
    expect(() =>
      verifySandboxToken(token, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW + 930 }),
    ).not.toThrow();
    expect(() =>
      verifySandboxToken(token, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW + 931 }),
    ).toThrow(expect.objectContaining({ code: 'token_expired' }));
  });

  it('refuses a wrong issuer, a foreign key, and a tampered payload', () => {
    const { signer, ring } = keys();
    const other = keys();
    const { token } = mintSandboxToken(signer, input());
    expect(() => verifySandboxToken(token, ring, { issuer: 'someone-else', now: NOW })).toThrow(
      /issuer/,
    );
    expect(() =>
      verifySandboxToken(token, other.ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW }),
    ).toThrow(/key id/);
    const [h, p, s] = token.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, wsk: 'sbx-other' })).toString('base64url')}.${s}`;
    expect(() =>
      verifySandboxToken(forged, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW }),
    ).toThrow(/signature/);
  });

  it('pins typ both ways: an API token is no sandbox token, and a sandbox token is no API token', () => {
    const { signer, ring } = keys();
    const api = signer.mint({
      sub: 'github:1',
      tenant: 'github:1',
      roles: [],
      scope: ['api'],
      ttlSeconds: 900,
      now: NOW,
    });
    expect(() =>
      verifySandboxToken(api, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW }),
    ).toThrow(/typ/);
    const { token } = mintSandboxToken(signer, input());
    expect(() => verifyToken(token, ring, { now: NOW, requiredScope: 'api' })).toThrow(/typ/);
  });

  it('refuses claims that are missing or empty', () => {
    const { signer, ring } = keys();
    for (const field of ['sub', 'sbx', 'wrk', 'wsk'] as const) {
      const t = signer.signJws(SANDBOX_TOKEN_TYP, {
        iss: DEFAULT_SANDBOX_ISSUER,
        aud: SANDBOX_TOKEN_AUDIENCE,
        sub: 'github:1',
        tenant: 'github:1',
        sbx: 'sbx-a',
        wrk: 'w',
        wsk: 'sbx-a',
        scope: ['exec'],
        iat: NOW,
        exp: NOW + 60,
        jti: 'j-1',
        [field]: '',
      });
      expect(
        () => verifySandboxToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW }),
        field,
      ).toThrow(new RegExp(field));
    }
    const noScope = signer.signJws(SANDBOX_TOKEN_TYP, {
      iss: DEFAULT_SANDBOX_ISSUER,
      aud: SANDBOX_TOKEN_AUDIENCE,
      sub: 's',
      tenant: 't',
      sbx: 'b',
      wrk: 'w',
      wsk: 'b',
      scope: ['files:read'],
      iat: NOW,
      exp: NOW + 60,
      jti: 'j-1',
    });
    expect(() =>
      verifySandboxToken(noScope, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW }),
    ).toThrow(/scope/);
  });

  it('refuses a token with wrong aud', () => {
    const { signer, ring } = keys();
    const t = signer.signJws(SANDBOX_TOKEN_TYP, {
      iss: DEFAULT_SANDBOX_ISSUER,
      aud: 'harness',
      sub: 'github:1',
      sbx: 'sbx-a',
      wrk: 'w',
      wsk: 'sbx-a',
      scope: ['exec'],
      iat: NOW,
      exp: NOW + 60,
    });
    expect(() => verifySandboxToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW })).toThrow(
      expect.objectContaining({ code: 'token_invalid', message: 'wrong token audience' }),
    );
  });

  it('refuses an unsigned token (alg: none) at the alg check, not as malformed', () => {
    const { signer, ring } = keys();
    // A known kid, the right typ and a NON-EMPTY signature segment: only the alg check refuses it.
    // An empty third segment would be refused earlier, as malformed, and test nothing about alg.
    const h = Buffer.from(
      JSON.stringify({ alg: 'none', typ: SANDBOX_TOKEN_TYP, kid: signer.kid }),
    ).toString('base64url');
    const p = Buffer.from(
      JSON.stringify({
        iss: DEFAULT_SANDBOX_ISSUER,
        aud: SANDBOX_TOKEN_AUDIENCE,
        sub: 'github:1',
        sbx: 'sbx-a',
        wrk: 'w',
        wsk: 'sbx-a',
        scope: ['exec'],
        iat: NOW,
        exp: NOW + 60,
      }),
    ).toString('base64url');
    const t = `${h}.${p}.${Buffer.from('not-a-signature').toString('base64url')}`;
    expect(() => verifySandboxToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW })).toThrow(
      expect.objectContaining({ code: 'token_invalid', message: 'unsupported alg' }),
    );
  });

  // Task 1 returned tenant, iat and jti unvalidated: a signed token missing them came back typed as
  // SandboxTokenClaims anyway. They are checked for type now; tenant must also be non-empty.
  it.each([
    ['tenant', { tenant: '' }],
    ['tenant', { tenant: 7 }],
    ['tenant', { tenant: undefined }],
    ['iat', { iat: 'yesterday' }],
    ['iat', { iat: undefined }],
    ['jti', { jti: 12 }],
    ['jti', { jti: undefined }],
  ] as const)('refuses a bad %s claim (%j)', (field, over) => {
    const { signer, ring } = keys();
    const t = signer.signJws(SANDBOX_TOKEN_TYP, {
      iss: DEFAULT_SANDBOX_ISSUER,
      aud: SANDBOX_TOKEN_AUDIENCE,
      sub: 'github:1',
      tenant: 'github:1',
      sbx: 'sbx-a',
      wrk: 'w',
      wsk: 'sbx-a',
      scope: ['exec'],
      iat: NOW,
      exp: NOW + 60,
      jti: 'j-1',
      ...over,
    });
    expect(() => verifySandboxToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW })).toThrow(
      expect.objectContaining({ code: 'token_invalid', message: expect.stringContaining(field) }),
    );
  });
});

/** A sandbox token's claims as a pre-change control plane minted them: no mode claims at all. */
const oldClaims = (over: object = {}) => ({
  iss: DEFAULT_SANDBOX_ISSUER,
  aud: SANDBOX_TOKEN_AUDIENCE,
  sub: 'github:1',
  tenant: 'github:1',
  sbx: 'sbx-a',
  wrk: 'w',
  wsk: 'sbx-a',
  scope: ['exec'],
  iat: NOW,
  exp: NOW + 60,
  jti: 'j-1',
  ...over,
});

describe('sandbox token mode claims (lease-mode spec §8.2)', () => {
  it('carries the mode, the mode epoch and the idle timeout it was minted with', () => {
    const { signer, ring } = keys();
    const { token } = mintSandboxToken(
      signer,
      input({ mode: 'lease', modeEpoch: 3, idleTimeoutS: 600 }),
    );
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(payload).toMatchObject({ mode: 'lease', mode_epoch: 3, idle_timeout_s: 600 });
    const c = verifySandboxToken(token, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW });
    expect(c).toMatchObject({ mode: 'lease', mode_epoch: 3, idle_timeout_s: 600 });
  });

  it('mints per-exec, epoch 0, idle 0 when given no mode', () => {
    const { signer, ring } = keys();
    const { token } = mintSandboxToken(signer, input());
    const c = verifySandboxToken(token, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW });
    expect(c).toMatchObject({ mode: 'per-exec', mode_epoch: 0, idle_timeout_s: 0 });
  });

  it('reads a token minted before the change as per-exec, epoch 0, idle 0', () => {
    const { signer, ring } = keys();
    const t = signer.signJws(SANDBOX_TOKEN_TYP, oldClaims());
    const c = verifySandboxToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW });
    expect(c).toMatchObject({ mode: 'per-exec', mode_epoch: 0, idle_timeout_s: 0 });
  });

  it.each([
    ['mode', { mode: 'resident' }],
    ['mode', { mode: 2 }],
    ['mode', { mode: null }],
    ['mode_epoch', { mode_epoch: -1 }],
    ['mode_epoch', { mode_epoch: 1.5 }],
    ['mode_epoch', { mode_epoch: '3' }],
    ['idle_timeout_s', { idle_timeout_s: -30 }],
    ['idle_timeout_s', { idle_timeout_s: 'forever' }],
  ] as const)('refuses a present but malformed %s claim (%j)', (field, over) => {
    const { signer, ring } = keys();
    const t = signer.signJws(SANDBOX_TOKEN_TYP, oldClaims(over));
    expect(() => verifySandboxToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW })).toThrow(
      expect.objectContaining({ code: 'token_invalid', message: expect.stringContaining(field) }),
    );
  });
});

describe('set-mode token (lease-mode spec §8.2)', () => {
  const modeInput = (over: Partial<Parameters<typeof mintSetModeToken>[1]> = {}) => ({
    sub: 'github:1',
    sbx: 'sbx-0123456789abcdef0123456789',
    wrk: 'sbx_default',
    wsk: 'sbx-0123456789abcdef0123456789',
    mode: 'lease' as const,
    modeEpoch: 4,
    idleTimeoutS: 120,
    notAfter: NOW + 7 * 86_400,
    iss: DEFAULT_SANDBOX_ISSUER,
    now: NOW,
    ...over,
  });

  it('round-trips under its own typ, with a 300 s lifetime', () => {
    const { signer, ring } = keys();
    const t = mintSetModeToken(signer, modeInput());
    expect(SANDBOX_MODE_TOKEN_TTL_S).toBe(300);
    expect(header(t)).toEqual({ alg: 'EdDSA', typ: SANDBOX_MODE_TOKEN_TYP, kid: signer.kid });
    const c = verifySetModeToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW + 1 });
    expect(c).toEqual({
      iss: DEFAULT_SANDBOX_ISSUER,
      aud: SANDBOX_TOKEN_AUDIENCE,
      sub: 'github:1',
      sbx: 'sbx-0123456789abcdef0123456789',
      wrk: 'sbx_default',
      wsk: 'sbx-0123456789abcdef0123456789',
      mode: 'lease',
      mode_epoch: 4,
      idle_timeout_s: 120,
      iat: NOW,
      exp: NOW + 300,
      jti: expect.any(String),
    });
  });

  it('caps exp at the sandbox expiry, and refuses to mint for an ended sandbox', () => {
    const { signer, ring } = keys();
    const t = mintSetModeToken(signer, modeInput({ notAfter: NOW + 60 }));
    expect(verifySetModeToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW }).exp).toBe(
      NOW + 60,
    );
    expect(() => mintSetModeToken(signer, modeInput({ notAfter: NOW }))).toThrow(
      expect.objectContaining({ code: 'sandbox_terminated' }),
    );
  });

  it('checks exp, with the sandbox token clock leeway and no more', () => {
    const { signer, ring } = keys();
    const t = mintSetModeToken(signer, modeInput());
    expect(() =>
      verifySetModeToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW + 330 }),
    ).not.toThrow();
    expect(() =>
      verifySetModeToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW + 331 }),
    ).toThrow(expect.objectContaining({ code: 'token_expired' }));
  });

  it('pins typ: no sandbox or API token stands in for it, and it stands in for neither', () => {
    const { signer, ring } = keys();
    const opts = { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW };
    const { token: sandbox } = mintSandboxToken(signer, input({ mode: 'lease', modeEpoch: 4 }));
    expect(() => verifySetModeToken(sandbox, ring, opts)).toThrow(/typ/);
    const api = signer.mint({
      sub: 'github:1',
      tenant: 'github:1',
      roles: [],
      scope: ['api'],
      ttlSeconds: 900,
      now: NOW,
    });
    expect(() => verifySetModeToken(api, ring, opts)).toThrow(/typ/);
    const setMode = mintSetModeToken(signer, modeInput());
    expect(() => verifySandboxToken(setMode, ring, opts)).toThrow(/typ/);
    expect(() => verifyToken(setMode, ring, { now: NOW, requiredScope: 'api' })).toThrow(/typ/);
  });

  it('refuses a wrong issuer, a wrong audience, a foreign key and a tampered payload', () => {
    const { signer, ring } = keys();
    const other = keys();
    const t = mintSetModeToken(signer, modeInput());
    expect(() => verifySetModeToken(t, ring, { issuer: 'someone-else', now: NOW })).toThrow(
      /issuer/,
    );
    expect(() =>
      verifySetModeToken(t, other.ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW }),
    ).toThrow(/key id/);
    const [h, p, s] = t.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, mode_epoch: 99 })).toString('base64url')}.${s}`;
    expect(() =>
      verifySetModeToken(forged, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW }),
    ).toThrow(/signature/);
    const wrongAud = signer.signJws(SANDBOX_MODE_TOKEN_TYP, { ...claims, aud: 'harness' });
    expect(() =>
      verifySetModeToken(wrongAud, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW }),
    ).toThrow(expect.objectContaining({ code: 'token_invalid', message: 'wrong token audience' }));
  });

  it.each([
    ['sub', { sub: '' }],
    ['sbx', { sbx: undefined }],
    ['wrk', { wrk: 7 }],
    ['wsk', { wsk: '' }],
    ['mode', { mode: undefined }],
    ['mode', { mode: 'resident' }],
    ['mode_epoch', { mode_epoch: undefined }],
    ['mode_epoch', { mode_epoch: -1 }],
    ['idle_timeout_s', { idle_timeout_s: undefined }],
    ['idle_timeout_s', { idle_timeout_s: 0.5 }],
    ['iat', { iat: undefined }],
    ['jti', { jti: 12 }],
    ['expiry', { exp: undefined }],
  ] as const)('refuses a missing or malformed %s claim (%j)', (field, over) => {
    const { signer, ring } = keys();
    const t = signer.signJws(SANDBOX_MODE_TOKEN_TYP, {
      iss: DEFAULT_SANDBOX_ISSUER,
      aud: SANDBOX_TOKEN_AUDIENCE,
      sub: 'github:1',
      sbx: 'sbx-a',
      wrk: 'w',
      wsk: 'sbx-a',
      mode: 'lease',
      mode_epoch: 1,
      idle_timeout_s: 0,
      iat: NOW,
      exp: NOW + 60,
      jti: 'j-1',
      ...over,
    });
    expect(() => verifySetModeToken(t, ring, { issuer: DEFAULT_SANDBOX_ISSUER, now: NOW })).toThrow(
      expect.objectContaining({ code: 'token_invalid', message: expect.stringContaining(field) }),
    );
  });
});
