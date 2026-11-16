import { beforeEach, describe, expect, it } from 'vitest';
import { mintGrants } from '../src/grant.js';
import { redeemInferenceGrant } from '../src/grant-redeem.js';
import { codeOf, seedCredential, type TestDeps } from './helpers/deps.js';
import { grantDeps, mint, seedSession, tombstone } from './helpers/grants.js';

describe('redeemInferenceGrant (MI1 §6.3)', () => {
  let d: TestDeps;
  beforeEach(async () => {
    d = grantDeps();
    await seedCredential(d);
    await seedSession(d);
  });

  it('resolves the credential the grant names', async () => {
    const r = await redeemInferenceGrant(mint(d).inferenceGrant, d);
    expect(r.credentialName).toBe('my-anthropic');
    expect(r.secretValue).toBe('sk-fake');
    expect(r.authHeader).toBe('authorization');
    expect(r.baseUrl).toBe('https://litellm.internal/v1');
    expect(r.sub).toBe('github:1234');
    expect(r.sessionId).toBe('sid-fixed');
  });

  it('refuses the sandbox half, a garbage token and a tampered one with one code', async () => {
    expect(await codeOf(() => redeemInferenceGrant(mint(d).sandboxGrant, d))).toBe('grant_invalid');
    expect(await codeOf(() => redeemInferenceGrant('not-a-token', d))).toBe('grant_invalid');
    const g = mint(d).inferenceGrant;
    expect(await codeOf(() => redeemInferenceGrant(`${g.slice(0, -4)}AAAA`, d))).toBe(
      'grant_invalid',
    );
  });

  it('refuses a grant past its exp and one past turn_exp', async () => {
    const nowS = Math.floor(d.now() / 1000);
    const stale = mint(d, { now: nowS - 3600, ttlSeconds: 60, turnExp: nowS - 1800 });
    expect(await codeOf(() => redeemInferenceGrant(stale.inferenceGrant, d))).toBe('grant_invalid');
  });

  it("refuses a tombstoned session, an unknown one, and another subject's", async () => {
    const good = mint(d).inferenceGrant;
    await tombstone(d, 'sid-fixed');
    expect(await codeOf(() => redeemInferenceGrant(good, d))).toBe('session_not_found');
    expect(
      await codeOf(() => redeemInferenceGrant(mint(d, { sid: 'sid-gone' }).inferenceGrant, d)),
    ).toBe('session_not_found');
    expect(
      await codeOf(() => redeemInferenceGrant(mint(d, { sub: 'github:9' }).inferenceGrant, d)),
    ).toBe('session_not_found');
  });

  it('refuses a credential deleted mid-turn, so revocation needs no TTL (D2, D4)', async () => {
    await d.credentials.delete('github:1234', 'my-anthropic');
    expect(await codeOf(() => redeemInferenceGrant(mint(d).inferenceGrant, d))).toBe(
      'credential_required',
    );
  });

  it('audits the operator fallback against the subject (§6.4)', async () => {
    const f = grantDeps({
      config: {
        operatorInferenceToken: 'sk-op',
        allowOperatorFallback: true,
        defaultInferenceEndpoint: 'https://litellm.internal/v1',
        operatorInferenceHeader: 'x-api-key',
      },
    });
    await seedSession(f); // a session that names NO credential
    const nowS = Math.floor(f.now() / 1000);
    const r = await redeemInferenceGrant(
      mintGrants(f.grantSigner!, {
        sub: 'github:1234',
        tenant: 'default',
        sid: 'sid-fixed',
        cred: '',
        egress: [],
        ttlSeconds: 1800,
        turnExp: nowS + 1800,
        now: nowS,
      }).inferenceGrant,
      f,
    );
    expect(r.usedOperatorFallback).toBe(true);
    expect(r.authHeader).toBe('x-api-key'); // from config.operatorInferenceHeader, not the default
    // The audit stream is a Redis stream, so read it the way grant-exchange.test.ts:150 does.
    const entries = [...f.streams.values()].flat();
    expect(entries.filter((e) => e.decision === 'operator_fallback_used')).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('sk-op');
  });

  it('never names the secret in a refusal', async () => {
    // The misdirected-secret path is the one that builds a message from the resolved triple.
    await seedCredential(d, 'github:1234', 'my-anthropic', {
      kind: 'api-key',
      endpoint: 'https://litellm.internal/v1',
      secret: { key: 'sk-ant-api-REDACTME' }, // notsecret
    });
    let msg = '';
    try {
      await redeemInferenceGrant(mint(d).inferenceGrant, d);
    } catch (e) {
      msg = JSON.stringify(e, Object.getOwnPropertyNames(e));
    }
    expect(msg).not.toContain('REDACTME');
  });
});
