import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRANT_ISSUER,
  GRANT_TYP,
  INFERENCE_GRANT_AUDIENCE,
  SANDBOX_GRANT_AUDIENCE,
  mintGrants,
  turnExp,
  verifyGrant,
} from '../src/grant.js';
import { makeSigner, publicKeyFromBase64, verifyToken } from '../src/token.js';

const NOW = 1_800_000_000;
const TURN_MAX = 1800;
const TTL = 300;

function keys() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  const ring = new Map<string, KeyObject>([
    [signer.kid, publicKeyFromBase64(signer.publicKeyBase64)],
  ]);
  return { signer, ring };
}

const input = (over: Partial<Parameters<typeof mintGrants>[1]> = {}) => ({
  sub: 'github:1234',
  tenant: 'github:1234',
  sid: 'sid-1',
  cred: 'my-anthropic',
  egress: ['corp-proxy'],
  ttlSeconds: TTL,
  turnExp: NOW + TURN_MAX,
  now: NOW,
  ...over,
});

const header = (t: string) => JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString());
const payload = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString());

/** Base claims that pass every check, so a case changes exactly the one field it is about. */
const claims = (over: Record<string, unknown> = {}) => ({
  iss: DEFAULT_GRANT_ISSUER,
  aud: INFERENCE_GRANT_AUDIENCE,
  sub: 'github:1234',
  tenant: 'github:1234',
  sid: 'sid-1',
  cred: 'my-anthropic',
  iat: NOW,
  exp: NOW + TTL,
  jti: 'j-1',
  turn_exp: NOW + TURN_MAX,
  ...over,
});

describe('turnExp (async spec §5.4)', () => {
  it('honors a cap below the ceiling, clamps one above it, and ignores a non-positive one', () => {
    expect(turnExp(NOW, 120, TURN_MAX)).toBe(NOW + 120);
    expect(turnExp(NOW, 99_999, TURN_MAX)).toBe(NOW + TURN_MAX);
    expect(turnExp(NOW, undefined, TURN_MAX)).toBe(NOW + TURN_MAX);
    // 0 and a negative read literally would mint an already-expired grant, which fails the turn
    // instead of bounding it. A cap is not a way to cancel.
    expect(turnExp(NOW, 0, TURN_MAX)).toBe(NOW + TURN_MAX);
    expect(turnExp(NOW, -5, TURN_MAX)).toBe(NOW + TURN_MAX);
  });
});

describe('mintGrants (MI1 §6.1)', () => {
  it('mints both halves with the pinned header and each audience its own claims', () => {
    const { signer, ring } = keys();
    const g = mintGrants(signer, input({ cfg: 'sha256:abc' }));
    for (const t of [g.inferenceGrant, g.sandboxGrant]) {
      expect(header(t)).toEqual({ alg: 'EdDSA', typ: GRANT_TYP, kid: signer.kid });
    }
    expect(g.exp).toBe(NOW + TTL);
    expect(g.turnExp).toBe(NOW + TURN_MAX);

    const inf = verifyGrant(g.inferenceGrant, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW });
    expect(inf).toMatchObject({
      iss: DEFAULT_GRANT_ISSUER,
      aud: INFERENCE_GRANT_AUDIENCE,
      sub: 'github:1234',
      tenant: 'github:1234',
      sid: 'sid-1',
      cred: 'my-anthropic',
      iat: NOW,
      exp: NOW + TTL,
      turn_exp: NOW + TURN_MAX,
    });
    // The inference half carries NO egress list and no bundle digest: §6.1 gives each audience only
    // the claims its own enforcement point reads.
    expect(payload(g.inferenceGrant).egress).toBeUndefined();
    expect(payload(g.inferenceGrant).cfg).toBeUndefined();

    const sbx = verifyGrant(g.sandboxGrant, ring, SANDBOX_GRANT_AUDIENCE, { now: NOW });
    expect(sbx).toMatchObject({
      aud: SANDBOX_GRANT_AUDIENCE,
      sid: 'sid-1',
      egress: ['corp-proxy'],
      cfg: 'sha256:abc',
      exp: NOW + TTL,
      turn_exp: NOW + TURN_MAX,
    });
    // ...and the sandbox half carries no credential name.
    expect(payload(g.sandboxGrant).cred).toBeUndefined();
  });

  it('omits cfg when the session binds no bundle', () => {
    const { signer } = keys();
    const g = mintGrants(signer, input());
    expect('cfg' in payload(g.sandboxGrant)).toBe(false);
  });

  it('gives each half its own jti, so two audit trails are not one event', () => {
    const { signer } = keys();
    const g = mintGrants(signer, input());
    expect(payload(g.inferenceGrant).jti).not.toBe(payload(g.sandboxGrant).jti);
  });

  it('clamps exp down to turn_exp, and refuses to mint once the turn is out of time', () => {
    const { signer } = keys();
    // Less turn left than one grant lifetime: exp follows the cap, not the TTL.
    expect(mintGrants(signer, input({ turnExp: NOW + 60 })).exp).toBe(NOW + 60);
    // More turn left than the TTL: exp is the TTL, which is what makes the worker refresh.
    expect(mintGrants(signer, input({ turnExp: NOW + 100_000 })).exp).toBe(NOW + TTL);
    expect(() => mintGrants(signer, input({ turnExp: NOW }))).toThrow(
      expect.objectContaining({ code: 'grant_invalid' }),
    );
  });
});

describe('verifyGrant (MI1 §12.2 rejection list)', () => {
  it('refuses a wrong alg and alg: none at the alg check, before the key is looked up', () => {
    const { signer, ring } = keys();
    const p = Buffer.from(JSON.stringify(claims())).toString('base64url');
    // A known kid, the right typ and a NON-EMPTY signature: only the alg check can refuse these.
    for (const alg of ['none', 'HS256', 'RS256']) {
      const h = Buffer.from(JSON.stringify({ alg, typ: GRANT_TYP, kid: signer.kid })).toString(
        'base64url',
      );
      const t = `${h}.${p}.${Buffer.from('not-a-signature').toString('base64url')}`;
      expect(() => verifyGrant(t, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW }), alg).toThrow(
        expect.objectContaining({ code: 'grant_invalid', message: 'unsupported alg' }),
      );
    }
  });

  it('refuses an unknown kid, a foreign key and a tampered payload', () => {
    const { signer, ring } = keys();
    const other = keys();
    const { inferenceGrant } = mintGrants(signer, input());
    expect(() =>
      verifyGrant(inferenceGrant, other.ring, INFERENCE_GRANT_AUDIENCE, { now: NOW }),
    ).toThrow(expect.objectContaining({ code: 'grant_invalid', message: 'unknown token key id' }));
    const [h, p, s] = inferenceGrant.split('.');
    // Swap the credential name the egress listener would read: the signature must catch it.
    const forged = `${h}.${Buffer.from(
      JSON.stringify({ ...payload(inferenceGrant), cred: 'someone-elses' }),
    ).toString('base64url')}.${s}`;
    expect(() => verifyGrant(forged, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW })).toThrow(
      expect.objectContaining({ code: 'grant_invalid', message: 'bad token signature' }),
    );
    expect(p).not.toBe(forged.split('.')[1]);
  });

  it('refuses a wrong audience, so neither half can be spent at the other enforcement point', () => {
    const { signer, ring } = keys();
    const g = mintGrants(signer, input());
    expect(() => verifyGrant(g.inferenceGrant, ring, SANDBOX_GRANT_AUDIENCE, { now: NOW })).toThrow(
      expect.objectContaining({ code: 'grant_invalid', message: 'wrong grant audience' }),
    );
    expect(() => verifyGrant(g.sandboxGrant, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW })).toThrow(
      expect.objectContaining({ code: 'grant_invalid', message: 'wrong grant audience' }),
    );
  });

  it('refuses a wrong issuer', () => {
    const { signer, ring } = keys();
    const { inferenceGrant } = mintGrants(signer, input({ iss: 'someone-else' }));
    expect(() => verifyGrant(inferenceGrant, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW })).toThrow(
      expect.objectContaining({ code: 'grant_invalid', message: 'wrong grant issuer' }),
    );
  });

  it('is valid THROUGH exp and expired one second later, with no clock leeway', () => {
    const { signer, ring } = keys();
    const { inferenceGrant } = mintGrants(signer, input());
    expect(() =>
      verifyGrant(inferenceGrant, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW + TTL }),
    ).not.toThrow();
    // No skew allowance, unlike the sandbox token's 30 s: leeway would only widen a stolen grant's
    // replay window, which the short lifetime exists to narrow.
    expect(() =>
      verifyGrant(inferenceGrant, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW + TTL + 1 }),
    ).toThrow(expect.objectContaining({ code: 'grant_invalid', message: 'grant expired' }));
  });

  it('refuses a grant presented past turn_exp even when its own exp is still in the future', () => {
    const { signer, ring } = keys();
    // Minted by hand, because mint keeps `exp <= turn_exp`: this is the state a verifier must still
    // refuse, since turn_exp is the cap a refresh carries forward and exp alone does not enforce it.
    const t = signer.signJws(GRANT_TYP, claims({ exp: NOW + 600, turn_exp: NOW + 60 }));
    expect(() => verifyGrant(t, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW + 61 })).toThrow(
      expect.objectContaining({
        code: 'grant_invalid',
        message: 'this turn has reached turn_exp',
      }),
    );
  });

  it('pins typ both ways: a session token is no grant, and a grant is no session token', () => {
    const { signer, ring } = keys();
    const session = signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['session'],
      ttlSeconds: 300,
      sid: 'sid-1',
      now: NOW,
    });
    // The §6.1 property, and the only thing enforcing it now that `aud: moca-sandbox` names two
    // different tokens: `typ` is checked before anything in the payload is read.
    expect(() => verifyGrant(session, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW })).toThrow(
      expect.objectContaining({
        code: 'grant_invalid',
        message: `wrong token typ (want ${GRANT_TYP})`,
      }),
    );
    const { inferenceGrant } = mintGrants(signer, input());
    expect(() => verifyToken(inferenceGrant, ring, { now: NOW, requiredScope: 'session' })).toThrow(
      /typ/,
    );
  });

  it('refuses a malformed token without reading a payload', () => {
    const { ring } = keys();
    for (const t of ['', 'a.b', 'a.b.c.d', 'a..c']) {
      expect(() => verifyGrant(t, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW }), t).toThrow(
        expect.objectContaining({ code: 'grant_invalid', message: 'malformed token' }),
      );
    }
  });

  it.each([
    ['sub', { sub: '' }],
    ['sub', { sub: 7 }],
    ['tenant', { tenant: '' }],
    ['sid', { sid: '' }],
    ['iat', { iat: 'soon' }],
    ['jti', { jti: 7 }],
    ['expiry', { exp: 'later' }],
    ['turn_exp', { turn_exp: null }],
  ])('refuses a signed grant whose %s is missing or the wrong type', (what, over) => {
    const { signer, ring } = keys();
    const t = signer.signJws(GRANT_TYP, claims(over));
    expect(() => verifyGrant(t, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW })).toThrow(
      new RegExp(what),
    );
  });

  it("accepts an inference grant whose cred is '', which is a session that named none", () => {
    const { signer, ring } = keys();
    const { inferenceGrant } = mintGrants(signer, input({ cred: '' }));
    expect(verifyGrant(inferenceGrant, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW })).toMatchObject(
      {
        cred: '',
      },
    );
    // ...but not one where it is absent or a non-string: the claim must exist for the token endpoint
    // to know the session made no choice, as distinct from a grant that forgot to say.
    for (const over of [{ cred: undefined }, { cred: 7 }]) {
      const t = signer.signJws(GRANT_TYP, claims(over));
      expect(() => verifyGrant(t, ring, INFERENCE_GRANT_AUDIENCE, { now: NOW })).toThrow(/cred/);
    }
  });

  it('refuses a sandbox grant whose egress is not a list of names, or whose cfg is not a string', () => {
    const { signer, ring } = keys();
    const sandbox = (over: Record<string, unknown>) =>
      signer.signJws(
        GRANT_TYP,
        claims({ aud: SANDBOX_GRANT_AUDIENCE, cred: undefined, egress: [], ...over }),
      );
    for (const over of [{ egress: undefined }, { egress: 'corp-proxy' }, { egress: [1] }]) {
      expect(() => verifyGrant(sandbox(over), ring, SANDBOX_GRANT_AUDIENCE, { now: NOW })).toThrow(
        /egress/,
      );
    }
    expect(() =>
      verifyGrant(sandbox({ cfg: 7 }), ring, SANDBOX_GRANT_AUDIENCE, { now: NOW }),
    ).toThrow(/cfg/);
    // An empty list is legitimate: a session with no egress credential may still run a sandbox.
    expect(verifyGrant(sandbox({}), ring, SANDBOX_GRANT_AUDIENCE, { now: NOW })).toMatchObject({
      egress: [],
    });
  });
});
