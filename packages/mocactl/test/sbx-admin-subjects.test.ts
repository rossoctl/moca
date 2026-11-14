import { describe, expect, it } from 'vitest';
import { parseUntil, sbxMain } from '../src/sbx/cli.js';
import { fakeCp, setup } from './helpers/sbx.js';

// `mocactl sbx admin subjects …`: enrollment and roles through the API.

const SUBJECT = {
  subject: 'github:9',
  enrolled: true,
  source: 'api',
  storeEnrolled: true,
  roles: [{ role: 'admin', source: 'api', until: 1_800_000_000, by: 'github:1' }],
};

describe('mocactl sbx admin subjects', () => {
  it('lists the subjects, for a person and as JSON', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'GET /v1/subjects': () => ({
        status: 200,
        body: {
          subjects: [
            {
              subject: 'github:1',
              enrolled: true,
              source: 'env',
              storeEnrolled: false,
              roles: [{ role: 'admin', source: 'env', until: null, by: null }],
            },
            { ...SUBJECT, subject: 'github:2', source: 'env', roles: [] },
            SUBJECT,
          ],
        },
      }),
    });
    const opts = { home, fetchImpl: cp.fetchImpl };
    expect(await sbxMain(['admin', 'subjects'], env, io, opts)).toBe(0);
    const out = io.outs.join('');
    expect(out).toContain('github:1  enrolled (env)  admin (env)');
    expect(out).toContain('github:2  enrolled (env, api too)\n');
    expect(out).toContain('github:9  enrolled (api)  admin (api, until 2027-01-15T08:00:00Z)');
    io.outs.length = 0;
    expect(await sbxMain(['admin', 'subjects', '--json'], env, io, opts)).toBe(0);
    expect(JSON.parse(io.outs.join(''))).toHaveLength(3);
  });

  it('enrolls, unenrolls, grants (with --until) and revokes, with the right requests', async () => {
    const { home, env, io } = setup();
    const answer = (record: string | null) => () => ({ status: 200, body: { ...SUBJECT, record } });
    // §3.6: each write reads the subjects first; none listed, so each answer is consistent with it.
    const cp = fakeCp({
      'GET /v1/subjects': () => ({ status: 200, body: { subjects: [] } }),
      'PUT /v1/subjects/github%3A9': answer('sha256:a'),
      'DELETE /v1/subjects/github%3A9': answer(null),
      'PUT /v1/subjects/github%3A9/roles/admin': answer('sha256:b'),
      'DELETE /v1/subjects/github%3A9/roles/admin': answer('sha256:c'),
    });
    const opts = { home, fetchImpl: cp.fetchImpl };
    expect(await sbxMain(['admin', 'subjects', 'enroll', 'github:9'], env, io, opts)).toBe(0);
    expect(cp.calls.at(-1)).toMatchObject({ method: 'PUT', body: { enrolled: true } });
    expect(await sbxMain(['admin', 'subjects', 'unenroll', 'github:9'], env, io, opts)).toBe(0);
    expect(io.outs.join('')).toContain('(unchanged)');
    expect(
      await sbxMain(
        ['admin', 'subjects', 'grant', 'github:9', '--until', '1800000000'],
        env,
        io,
        opts,
      ),
    ).toBe(0);
    expect(cp.calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/v1/subjects/github%3A9/roles/admin',
      body: { until: 1_800_000_000 },
    });
    expect(await sbxMain(['admin', 'subjects', 'grant', 'github:9'], env, io, opts)).toBe(0);
    expect(cp.calls.at(-1)).toMatchObject({ body: {} });
    expect(await sbxMain(['admin', 'subjects', 'revoke', 'github:9'], env, io, opts)).toBe(0);
    expect(cp.calls.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('compares an enroll with the store enrollment, not the folded one (no false race)', async () => {
    const { home, env, io } = setup();
    let listed: Record<string, unknown>;
    let record: string | null;
    const cp = fakeCp({
      'GET /v1/subjects': () => ({ status: 200, body: { subjects: [listed] } }),
      'PUT /v1/subjects/github%3A9': () => ({
        status: 200,
        body: { ...listed, enrolled: true, storeEnrolled: true, record },
      }),
    });
    const opts = { home, fetchImpl: cp.fetchImpl };
    const enroll = () => sbxMain(['admin', 'subjects', 'enroll', 'github:9'], env, io, opts);
    // A settings subject: the control plane answers it unchanged.
    listed = { ...SUBJECT, source: 'env', storeEnrolled: false, roles: [] };
    record = null;
    expect(await enroll()).toBe(0);
    // Enrolled by an API admin grant only: the enroll writes the store enrollment.
    listed = { ...SUBJECT, storeEnrolled: false };
    record = 'sha256:a';
    expect(await enroll()).toBe(0);
    expect(io.errs.join('\n')).not.toContain('changed by someone else');
    // Read as store-enrolled, yet this write changed it: a real race, reported.
    listed = { ...SUBJECT, storeEnrolled: true };
    expect(await enroll()).toBe(1);
    expect(io.errs.join('\n')).toContain('changed by someone else');
  });

  it('reports a 403 plainly and makes no second call (never retried as another role)', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'GET /v1/subjects': () => ({
        status: 403,
        body: { error: 'forbidden', message: 'managing subjects requires the admin role' },
      }),
    });
    const opts = { home, fetchImpl: cp.fetchImpl };
    expect(await sbxMain(['admin', 'subjects'], env, io, opts)).toBe(1);
    expect(io.errs.join('\n')).toContain('requires the admin role');
    expect(cp.calls.filter((c) => c.path.startsWith('/v1/subjects'))).toHaveLength(1);
  });

  it('reports a control-plane refusal (403, 409) and refuses bad usage locally', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'GET /v1/subjects': () => ({ status: 200, body: { subjects: [] } }),
      'DELETE /v1/subjects/github%3A1/roles/admin': () => ({
        status: 409,
        body: { error: 'bootstrap_subject', message: 'github:1 is an admin by the settings' },
      }),
    });
    const opts = { home, fetchImpl: cp.fetchImpl };
    expect(await sbxMain(['admin', 'subjects', 'revoke', 'github:1'], env, io, opts)).not.toBe(0);
    expect(io.errs.join('\n')).toContain('github:1 is an admin by the settings');
    const calls = cp.calls.length;
    expect(await sbxMain(['admin', 'subjects', 'enroll'], env, io, opts)).toBe(2);
    expect(await sbxMain(['admin', 'subjects', 'promote', 'github:9'], env, io, opts)).toBe(2);
    expect(
      await sbxMain(['admin', 'subjects', 'enroll', 'github:9', '--until', '1h'], env, io, opts),
    ).toBe(2);
    expect(
      await sbxMain(['admin', 'subjects', 'grant', 'github:9', '--until', 'soon'], env, io, opts),
    ).toBe(2);
    expect(await sbxMain(['admin'], env, io, opts)).toBe(2);
    expect(cp.calls.length).toBe(calls);
  });
});

describe('parseUntil', () => {
  it('reads a duration or future epoch seconds, and nothing else', () => {
    expect(parseUntil('30m', 1000)).toBe(2800);
    expect(parseUntil('2h', 0)).toBe(7200);
    expect(parseUntil('1d', 0)).toBe(86_400);
    expect(parseUntil('5000', 1000)).toBe(5000);
    expect(parseUntil('500', 1000)).toBeUndefined();
    expect(parseUntil('0m', 0)).toBeUndefined();
    expect(parseUntil('1w', 0)).toBeUndefined();
    expect(parseUntil('-5', 0)).toBeUndefined();
    // At most 365 days ahead, so epoch milliseconds are refused, and a day under the control
    // plane's 366 so a client clock running ahead of the server's still gets the advertised maximum.
    expect(parseUntil('365d', 0)).toBe(365 * 86_400);
    expect(parseUntil('366d', 0)).toBeUndefined();
    expect(parseUntil(String(1_800_000_000_000), 1_700_000_000)).toBeUndefined();
    expect(parseUntil(String(1_700_000_000 + 365 * 86_400), 1_700_000_000)).toBe(
      1_700_000_000 + 365 * 86_400,
    );
    expect(parseUntil(String(1_700_000_000 + 365 * 86_400 + 1), 1_700_000_000)).toBeUndefined();
  });
});
