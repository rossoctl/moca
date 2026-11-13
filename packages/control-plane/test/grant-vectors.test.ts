import { readFileSync } from 'node:fs';
import { type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GRANT_TYP, verifyGrant, type GrantAudience } from '../src/grant.js';
import { keyIdFor, publicKeyFromBase64 } from '../src/token.js';

/**
 * MI1 §12.2's cross-language grant vectors. The fixture is the contract between this verifier and
 * the Go one in `moca-egress` / `microvm-worker`: both read the same file by relative path and must
 * accept exactly the same tokens. A verifier that drifts -- skips the `typ` check, allows clock
 * leeway, trusts `exp` and forgets `turn_exp` -- fails a vector rather than failing in production.
 *
 * The fixture holds the PUBLIC key only: the private half was generated for the one authoring run
 * and thrown away, so nothing in the repo can mint these. That also keeps the blob clear of a
 * committed Ed25519 private key, which is a gitleaks finding no later comment can retract (the same
 * reason `helpers/deps.ts` generates its signer per call).
 *
 * Each vector carries `segments` rather than a token: a whole compact JWS is a finding for every
 * secret scanner that walks this repo, and arguing a committed one is a fixture costs every future
 * contributor a bypass. These are public by construction, so joining three strings with a dot is
 * the reader's job -- one line here, one line in the Go verifier.
 *
 * shortcut: these pin the VERIFIER, not a minter -- without the private key nothing can reproduce
 * the vectors byte-for-byte. Upgrade when a second language mints grants (today only the control
 * plane does, and `grant.test.ts` covers its claim shapes); that needs a key-custody decision first.
 */
interface Vector {
  name: string;
  aud: GrantAudience;
  now: number;
  expect: 'accept' | 'reject';
  reason?: string;
  claims?: Record<string, unknown>;
  segments: string[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/grant-vectors.json', import.meta.url), 'utf8'),
) as {
  typ: string;
  issuer: string;
  kid: string;
  publicKeyBase64: string;
  vectors: Vector[];
};

const key: KeyObject = publicKeyFromBase64(fixture.publicKeyBase64);
const ring = new Map<string, KeyObject>([[fixture.kid, key]]);

describe('grant vectors (MI1 §12.2)', () => {
  it('pins the format the other languages verify against', () => {
    // If this fails, the fixture was regenerated against a changed format: every out-of-tree
    // verifier needs the new file, so the drift must be deliberate and announced.
    expect(fixture.typ).toBe(GRANT_TYP);
    expect(keyIdFor(key)).toBe(fixture.kid);
    expect(fixture.vectors.length).toBeGreaterThan(10);
    expect(fixture.vectors.some((v) => v.expect === 'accept')).toBe(true);
    expect(fixture.vectors.some((v) => v.expect === 'reject')).toBe(true);
    // Names are the handle another language reports a failure under, so they must be unique.
    expect(new Set(fixture.vectors.map((v) => v.name)).size).toBe(fixture.vectors.length);
  });

  it.each(fixture.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const token = v.segments.join('.');
    if (v.expect === 'accept') {
      const claims = verifyGrant(token, ring, v.aud, { now: v.now, issuer: fixture.issuer });
      expect(claims).toEqual(v.claims);
      return;
    }
    expect(() => verifyGrant(token, ring, v.aud, { now: v.now, issuer: fixture.issuer })).toThrow(
      expect.objectContaining({ code: 'grant_invalid' }),
    );
  });
});
