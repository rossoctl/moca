import { describe, expect, it, vi } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { AUDIT_STREAM, OwnershipIndex } from '../src/ownership.js';
import { codeOf, ctx, makeDeps } from './helpers/deps.js';
import { fakeRedis } from './helpers/fake-redis.js';
import { StubIdentity } from './helpers/stub-identity.js';

const sandboxDeps = (subject: string, roles: string[] = []) =>
  makeDeps({
    config: { routeProfile: 'sandbox' },
    identity: new StubIdentity({ subject, displayName: 'X', roles }),
  });

const login = async (d: ReturnType<typeof makeDeps>) =>
  (await HANDLERS.completeDeviceAuth!(ctx({ body: { deviceCode: 'dc-1' } }), d)).body as {
    refreshToken: string;
  };
const refresh = (d: ReturnType<typeof makeDeps>, token: string) =>
  HANDLERS.refreshAuth!(ctx({ body: { grant_type: 'refresh_token', refresh_token: token } }), d);

describe('enrollment gates login and refresh on the sandbox profile (SBX0 §4.2)', () => {
  it('refuses a device-flow login by an unlisted subject, and issues no refresh family', async () => {
    const d = sandboxDeps('github:777');
    expect(
      await codeOf(() => HANDLERS.completeDeviceAuth!(ctx({ body: { deviceCode: 'dc-1' } }), d)),
    ).toBe('not_enrolled');
    expect(d.refreshAudit.filter((a) => a.decision === 'refresh_issued')).toEqual([]); // issue() never ran
  });

  it('logs in a listed subject, and an admin who is not listed', async () => {
    const ok = await HANDLERS.completeDeviceAuth!(
      ctx({ body: { deviceCode: 'dc-1' } }),
      sandboxDeps('github:1234'),
    );
    expect(ok.status).toBe(200);
    const admin = await HANDLERS.completeDeviceAuth!(
      ctx({ body: { deviceCode: 'dc-1' } }),
      sandboxDeps('github:1', ['admin']),
    );
    expect(admin.status).toBe(200);
  });

  it('stops a de-enrolled subject at the next refresh', async () => {
    const d = sandboxDeps('github:1234');
    const first = await login(d);
    d.config.sandbox!.allowedSubjects = [];
    expect(await codeOf(() => refresh(d, first.refreshToken))).toBe('not_enrolled');
  });

  it('names the caller in the not_enrolled message, so the user can hand it to an operator', async () => {
    const login403 = await HANDLERS.completeDeviceAuth!(
      ctx({ body: { deviceCode: 'dc-1' } }),
      sandboxDeps('github:777'),
    ).catch((e: Error) => e.message);
    expect(login403).toContain('github:777');
    const d = sandboxDeps('github:1234');
    const first = await login(d);
    d.config.sandbox!.allowedSubjects = [];
    expect(await refresh(d, first.refreshToken).catch((e: Error) => e.message)).toContain(
      'github:1234',
    );
  });

  it('revokes the family of a de-enrolled refresh, so the old token is a plain refusal, not theft', async () => {
    const d = sandboxDeps('github:1234');
    const first = await login(d);
    d.config.sandbox!.allowedSubjects = [];
    expect(await codeOf(() => refresh(d, first.refreshToken))).toBe('not_enrolled');
    expect(d.refreshAudit.at(-1)).toMatchObject({
      decision: 'refresh_revoked',
      reason: 'not_enrolled',
      subject: 'github:1234',
    });
    // The client kept the token it presented; long past the grace window it comes back.
    const later = { ...d, now: () => d.now() + 120_000 };
    expect(await codeOf(() => refresh(later, first.refreshToken))).toBe('invalid_grant');
    expect(d.refreshAudit.filter((a) => a.decision === 'refresh_reuse_detected')).toEqual([]);
    expect(d.refreshAudit.at(-1)).toMatchObject({ decision: 'refresh_refused', reason: 'revoked' });
    // Re-enrolled, the user logs in again; the revoked login stays revoked.
    d.config.sandbox!.allowedSubjects = ['github:1234'];
    expect(await codeOf(() => refresh(later, first.refreshToken))).toBe('invalid_grant');
  });

  it('still answers not_enrolled when revoking the de-enrolled family fails', async () => {
    // A 503 here would read as "unreachable" to the client, which would then keep the superseded
    // token and trip reuse detection on its next refresh: the revoke is best effort.
    const d = sandboxDeps('github:1234');
    const first = await login(d);
    d.config.sandbox!.allowedSubjects = [];
    d.refresh.revoke = async () => {
      throw new Error('redis is gone');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await codeOf(() => refresh(d, first.refreshToken))).toBe('not_enrolled');
      expect(err.mock.calls.join(' ')).toContain('revoking a de-enrolled family failed');
    } finally {
      err.mockRestore();
    }
  });

  it('refreshes a subject who is still enrolled, and an admin who never was listed', async () => {
    // The positive control for the test above: the refusal is the allow list, not the refresh.
    const d = sandboxDeps('github:1234');
    expect((await refresh(d, (await login(d)).refreshToken)).status).toBe(200);
    const a = sandboxDeps('github:1', ['admin']);
    expect((await refresh(a, (await login(a)).refreshToken)).status).toBe(200);
  });

  it('does not gate the harness profile', async () => {
    const d = makeDeps({
      identity: new StubIdentity({ subject: 'github:777', displayName: 'X', roles: [] }),
    });
    expect(
      (await HANDLERS.completeDeviceAuth!(ctx({ body: { deviceCode: 'dc-1' } }), d)).status,
    ).toBe(200);
    d.config.sandbox!.allowedSubjects = [];
    expect((await refresh(d, (await login(d)).refreshToken)).status).toBe(200);
  });
});

describe('discovery under each profile (SBX0 §4.1, spec v1.1)', () => {
  it('advertises only the profile and the exec endpoint on the sandbox profile', async () => {
    const sbx = await HANDLERS.getDiscovery!(ctx(), sandboxDeps('github:1234'));
    expect(sbx).toEqual({
      status: 200,
      body: { profile: 'sandbox', execEndpoint: 'sbx-exec.apps.example.invalid:443' },
    });
  });

  it('adds the exec CA when the exec certificate is self-issued', async () => {
    const d = sandboxDeps('github:1234');
    d.config.sandbox!.execCa = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    expect((await HANDLERS.getDiscovery!(ctx(), d)).body).toEqual({
      profile: 'sandbox',
      execEndpoint: 'sbx-exec.apps.example.invalid:443',
      execCa: d.config.sandbox!.execCa,
    });
  });

  it('refuses, rather than answering the harness body, on a sandbox profile with no sandbox config', async () => {
    const d = sandboxDeps('github:1234');
    delete d.config.sandbox;
    expect(await codeOf(() => HANDLERS.getDiscovery!(ctx(), d))).toBe('internal_error');
  });

  it('keeps the harness body and names its profile, with no exec endpoint', async () => {
    const harness = (await HANDLERS.getDiscovery!(ctx(), makeDeps())).body as Record<
      string,
      unknown
    >;
    expect(harness.profile).toBe('harness');
    expect(harness).not.toHaveProperty('execEndpoint');
    expect(harness).not.toHaveProperty('execCa');
  });
});

describe('the audit stream names a sandbox (SBX0 §5)', () => {
  it('writes sandboxId when given, and omits it otherwise', async () => {
    const f = fakeRedis();
    const index = new OwnershipIndex(f.redis);
    await index.audit({
      subject: 'github:1234',
      sandboxId: 'sbx-0123',
      decision: 'sandbox_created',
    });
    await index.audit({ subject: 'github:1234', decision: 'x' });
    const [withId, without] = f.streams.get(AUDIT_STREAM)!;
    expect(withId).toMatchObject({
      subject: 'github:1234',
      sandboxId: 'sbx-0123',
      decision: 'sandbox_created',
    });
    expect(without).not.toHaveProperty('sandboxId');
  });
});
