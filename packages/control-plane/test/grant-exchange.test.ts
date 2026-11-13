import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseCredentialBody } from '../src/credential-store.js';
import {
  INFERENCE_GRANT_AUDIENCE,
  SANDBOX_GRANT_AUDIENCE,
  mintGrants,
  verifyGrant,
} from '../src/grant.js';
import { issueTurnGrants, refreshTurnGrants } from '../src/grant-exchange.js';
import { HANDLERS, type CpDeps } from '../src/handlers.js';
import { makeSigner, publicKeyFromBase64 } from '../src/token.js';
import {
  alice,
  codeOf,
  ctx,
  makeDeps,
  seedBundle,
  seedCredential,
  type TestDeps,
} from './helpers/deps.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

/**
 * The grant ring, generated per call for the reason `makeDeps` gives about its own signer: a
 * committed Ed25519 private key would be a gitleaks finding on the blob. Separate from `deps.signer`
 * on purpose -- that separation is the §6.1 property these tests exercise.
 */
function grantRing(): {
  grantSigner: ReturnType<typeof makeSigner>;
  grantVerifyKeys: Map<string, KeyObject>;
} {
  const { privateKey } = generateKeyPairSync('ed25519');
  const grantSigner = makeSigner(
    privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    'MOCA_GRANT_SIGNING_KEY',
  );
  return {
    grantSigner,
    grantVerifyKeys: new Map([[grantSigner.kid, publicKeyFromBase64(grantSigner.publicKeyBase64)]]),
  };
}

function grantDeps(over: Parameters<typeof makeDeps>[0] = {}): TestDeps {
  return makeDeps({ ...grantRing(), ...over });
}

/** Create a session through the real handler and return its session token. */
async function sessionToken(d: CpDeps, body: object = {}, id = 'sid-fixed'): Promise<string> {
  const res = await HANDLERS.createSession!(ctx({ principal: alice, body }), {
    ...d,
    newId: () => id,
  });
  return (res.body as { token: string }).token;
}

async function seedEgress(d: CpDeps, name: string, host: string): Promise<void> {
  await d.credentials.put(
    'github:1234',
    parseCredentialBody(name, {
      kind: 'bearer',
      consumer: 'sandbox-egress',
      destination: { hosts: [host] },
      secret: { token: 'ghp-fake' }, // notsecret
    }),
  );
}

const nowS = (d: CpDeps) => Math.floor(d.now() / 1000);

describe('issueTurnGrants (MI1 §6.2)', () => {
  let d: TestDeps;
  beforeEach(async () => {
    d = grantDeps();
    await seedCredential(d); // github:1234 / my-anthropic
  });

  it('mints both halves from the session record, with names and never a secret', async () => {
    await seedEgress(d, 'corp-proxy', 'api.github.com');
    seedBundle(d, DIGEST);
    const token = await sessionToken(d, {
      credentials: { inference: 'my-anthropic' },
      configRef: DIGEST,
    });
    const res = await issueTurnGrants(token, d);

    expect(res.turnExp).toBe(nowS(d) + d.config.turnMaxS);
    expect(res.exp).toBe(nowS(d) + d.config.grantTtlS);
    expect(res.cfg).toBe(DIGEST);

    const inf = verifyGrant(res.inferenceGrant, d.grantVerifyKeys!, INFERENCE_GRANT_AUDIENCE, {
      now: nowS(d),
    });
    expect(inf).toMatchObject({
      sub: 'github:1234',
      tenant: 'github:1234',
      sid: 'sid-fixed',
      // The NAME off the record, which is the whole point: a capability, not a secret.
      cred: 'my-anthropic',
      turn_exp: res.turnExp,
      exp: res.exp,
    });
    expect(
      verifyGrant(res.sandboxGrant, d.grantVerifyKeys!, SANDBOX_GRANT_AUDIENCE, { now: nowS(d) }),
    ).toMatchObject({ sid: 'sid-fixed', egress: ['corp-proxy'], cfg: DIGEST });
  });

  it('lists only the sandbox-egress names, never the inference credential, in egress', async () => {
    await seedEgress(d, 'corp-proxy', 'api.github.com');
    await seedEgress(d, 'npm-registry', 'registry.npmjs.org');
    const res = await issueTurnGrants(await sessionToken(d), d);
    const sbx = verifyGrant(res.sandboxGrant, d.grantVerifyKeys!, SANDBOX_GRANT_AUDIENCE, {
      now: nowS(d),
    });
    expect((sbx as { egress: string[] }).egress.sort()).toEqual(['corp-proxy', 'npm-registry']);
    expect((sbx as { egress: string[] }).egress).not.toContain('my-anthropic');
  });

  it('omits cfg when the session binds no bundle', async () => {
    const res = await issueTurnGrants(await sessionToken(d), d);
    expect(res.cfg).toBeUndefined();
    expect('cfg' in res).toBe(false);
  });

  it('carries NO secret value in the response or in the audit entry (spec §7.2)', async () => {
    await seedEgress(d, 'corp-proxy', 'api.github.com');
    const res = await issueTurnGrants(await sessionToken(d), d);
    // The one assertion that earns its keep: serialize EVERYTHING that left the control plane --
    // the response, the audit stream, and the audit log lines -- and look for the stored secrets.
    // A grant is a capability; if a secret ever rides along, the whole slice is pointless.
    const everything = JSON.stringify([
      res,
      // The grants' own payloads too, not just the compact strings: base64url hides a leak from a
      // substring search on the token.
      JSON.parse(Buffer.from(res.inferenceGrant.split('.')[1]!, 'base64url').toString()),
      JSON.parse(Buffer.from(res.sandboxGrant.split('.')[1]!, 'base64url').toString()),
      [...d.streams.entries()],
      d.logLines,
    ]);
    expect(everything).not.toContain('sk-fake'); // notsecret
    expect(everything).not.toContain('ghp-fake'); // notsecret
    // ...while the NAMES are present, which is what a redeemer needs.
    expect(everything).toContain('my-anthropic');
    expect(everything).toContain('corp-proxy');
  });

  it('audits the issue with the credential name and the decision', async () => {
    await issueTurnGrants(await sessionToken(d), d);
    const entries = [...d.streams.values()].flat().filter((e) => e.decision === 'grants_issued');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      subject: 'github:1234',
      sessionId: 'sid-fixed',
      credential: 'my-anthropic',
    });
  });

  it('refuses an api-scoped token, an unknown session, another owner and a tombstone alike', async () => {
    const api = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['api'],
      sid: 'sid-fixed',
      ttlSeconds: 3600,
    });
    await sessionToken(d);
    expect(await codeOf(() => issueTurnGrants(api, d))).toBe('token_invalid');

    const orphan = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['turn:write'],
      sid: 'never-created',
      ttlSeconds: 300,
    });
    expect(await codeOf(() => issueTurnGrants(orphan, d))).toBe('session_not_found');

    const token = await sessionToken(d);
    const rec = (await d.index.get('sid-fixed'))!;
    await d.index.create({ ...rec, owner: 'github:9999' });
    expect(await codeOf(() => issueTurnGrants(token, d))).toBe('session_not_found');

    await d.index.create(rec);
    await d.index.tombstone('sid-fixed');
    expect(await codeOf(() => issueTurnGrants(token, d))).toBe('session_not_found');
  });

  it('is an internal_error, not a 4xx, when the ring is unconfigured', async () => {
    // Both routes are feature-gated off without a key and 404 before the body is read, so reaching
    // the function with no signer is a wiring fault rather than caller input.
    const noRing = makeDeps();
    await seedCredential(noRing);
    const token = await sessionToken(noRing);
    expect(await codeOf(() => issueTurnGrants(token, noRing))).toBe('internal_error');
  });
});

describe('refreshTurnGrants (MI1 §6.2)', () => {
  let d: TestDeps;
  beforeEach(async () => {
    d = grantDeps();
    await seedCredential(d);
  });

  it('accepts either half and returns a new exp with turn_exp and sid unchanged', async () => {
    const first = await issueTurnGrants(await sessionToken(d), d);
    // 100 s later: the refresh must move `exp` forward and leave the absolute cap alone.
    const later = { ...d, now: () => d.now() + 100_000 };
    for (const presented of [first.inferenceGrant, first.sandboxGrant]) {
      const res = await refreshTurnGrants(presented, later);
      expect(res.turnExp).toBe(first.turnExp);
      expect(res.exp).toBe(nowS(later) + d.config.grantTtlS);
      expect(res.exp).toBeGreaterThan(first.exp);
      expect(
        verifyGrant(res.inferenceGrant, d.grantVerifyKeys!, INFERENCE_GRANT_AUDIENCE, {
          now: nowS(later),
        }),
      ).toMatchObject({ sid: 'sid-fixed', cred: 'my-anthropic', turn_exp: first.turnExp });
    }
  });

  it('reconstructs BOTH halves from the session, including the one the presented grant lacks', async () => {
    await seedEgress(d, 'corp-proxy', 'api.github.com');
    const first = await issueTurnGrants(await sessionToken(d), d);
    // Presenting the INFERENCE half, which carries no egress list at all: the sandbox half still
    // comes back complete, because the session record is re-read rather than the claims echoed (D4).
    const res = await refreshTurnGrants(first.inferenceGrant, d);
    expect(
      verifyGrant(res.sandboxGrant, d.grantVerifyKeys!, SANDBOX_GRANT_AUDIENCE, { now: nowS(d) }),
    ).toMatchObject({ egress: ['corp-proxy'] });
  });

  it('picks up a credential change made mid-turn, instead of echoing the old name (D4)', async () => {
    const first = await issueTurnGrants(await sessionToken(d), d);
    const rec = (await d.index.get('sid-fixed'))!;
    await d.index.create({ ...rec, credentialName: 'other-anthropic' });
    const res = await refreshTurnGrants(first.sandboxGrant, d);
    expect(
      verifyGrant(res.inferenceGrant, d.grantVerifyKeys!, INFERENCE_GRANT_AUDIENCE, {
        now: nowS(d),
      }),
    ).toMatchObject({ cred: 'other-anthropic' });
  });

  it('clamps the refreshed exp to turn_exp as the turn runs out', async () => {
    // A turn ceiling barely above one grant lifetime, so the FIRST refresh is already the clamping
    // one. With the 1800 s default the worker would have to refresh six times to get here, and the
    // presented grant would have expired on the way -- the clamp is what stops that.
    const short = grantDeps({ config: { turnMaxS: 350 } });
    await seedCredential(short);
    const first = await issueTurnGrants(await sessionToken(short), short);
    expect(first.exp).toBe(nowS(short) + 300);
    const nearEnd = { ...short, now: () => short.now() + 290_000 };
    const res = await refreshTurnGrants(first.inferenceGrant, nearEnd);
    expect(res.turnExp).toBe(first.turnExp);
    expect(res.exp).toBe(first.turnExp);
  });

  it('refuses outright once turn_exp has passed, rather than extending the turn', async () => {
    const first = await issueTurnGrants(await sessionToken(d), d);
    const after = { ...d, now: () => (first.turnExp + 1) * 1000 };
    expect(await codeOf(() => refreshTurnGrants(first.inferenceGrant, after))).toBe(
      'grant_invalid',
    );
  });

  it('refuses a session token, a foreign-key grant and a tampered grant with one code', async () => {
    const token = await sessionToken(d);
    expect(await codeOf(() => refreshTurnGrants(token, d))).toBe('grant_invalid');

    const other = grantRing();
    const foreign = mintGrants(other.grantSigner, {
      sub: 'github:1234',
      tenant: 'github:1234',
      sid: 'sid-fixed',
      cred: 'my-anthropic',
      egress: [],
      ttlSeconds: 300,
      turnExp: nowS(d) + 1800,
      now: nowS(d),
    });
    expect(await codeOf(() => refreshTurnGrants(foreign.inferenceGrant, d))).toBe('grant_invalid');

    const first = await issueTurnGrants(token, d);
    const [h, , s] = first.inferenceGrant.split('.');
    const forged = `${h}.${Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(first.inferenceGrant.split('.')[1]!, 'base64url').toString()),
        turn_exp: nowS(d) + 999_999,
      }),
    ).toString('base64url')}.${s}`;
    expect(await codeOf(() => refreshTurnGrants(forged, d))).toBe('grant_invalid');
  });

  it('names the real structural fault, not an audience mismatch, on a token that is no grant', async () => {
    // The either-audience loop keeps the FIRST failure: the second attempt would always say 'wrong
    // grant audience', which would mislabel every bad signature and wrong typ in the system.
    const token = await sessionToken(d);
    try {
      await refreshTurnGrants(token, d);
      expect.unreachable('expected a throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/typ/);
      expect((e as Error).message).not.toMatch(/audience/);
    }
  });

  it('refuses a valid grant whose session has been tombstoned mid-turn', async () => {
    const first = await issueTurnGrants(await sessionToken(d), d);
    await d.index.tombstone('sid-fixed');
    expect(await codeOf(() => refreshTurnGrants(first.inferenceGrant, d))).toBe(
      'session_not_found',
    );
  });

  it("refuses a grant minted for one subject against another's session", async () => {
    const first = await issueTurnGrants(await sessionToken(d), d);
    const rec = (await d.index.get('sid-fixed'))!;
    await d.index.create({ ...rec, owner: 'github:9999' });
    expect(await codeOf(() => refreshTurnGrants(first.inferenceGrant, d))).toBe(
      'session_not_found',
    );
  });

  it('audits the refresh under its own decision', async () => {
    const first = await issueTurnGrants(await sessionToken(d), d);
    await refreshTurnGrants(first.inferenceGrant, d);
    const decisions = [...d.streams.values()].flat().map((e) => e.decision);
    expect(decisions).toContain('grants_issued');
    expect(decisions).toContain('grants_refreshed');
  });
});
