import { beforeEach, describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { ROUTES } from '../src/routes.js';
import { countAsync, resetAsyncCounters } from '../src/counters.js';
import { makeDeps, ctx, admin, alice, codeOf } from './helpers/deps.js';

describe('GET /metrics', () => {
  beforeEach(() => resetAsyncCounters());

  /**
   * On BOTH profiles. The sandbox profile is the only one that runs a file or Vault credential store
   * with egress credentials, so it is the only profile where `credential_nonprimary_kek_reads` can
   * move -- harness-only would leave the KEK rotation procedure (RUNBOOK) unreadable exactly where it
   * is needed. Asserted rather than left implicit, because dropping `sandbox` here would silently
   * 404 that procedure.
   */
  it('is declared once, on both profiles', () => {
    const route = ROUTES.filter((r) => r.path === '/metrics');
    expect(route).toHaveLength(1);
    expect(route[0]).toMatchObject({
      method: 'GET',
      auth: 'api',
      sessionScoped: false,
      operationId: 'getMetrics',
      profiles: ['harness', 'sandbox'],
    });
  });

  it('reports zero before any refusal', async () => {
    const res = await HANDLERS.getMetrics!(ctx({ principal: admin }), makeDeps());
    expect(res.status).toBe(200);
    // The WHOLE body, so a counter added to the module shows up here as a failing assertion rather
    // than appearing on an operator's /metrics unannounced.
    expect(res.body).toEqual({
      counters: { async_quota_refusals: 0, credential_nonprimary_kek_reads: 0 },
    });
  });

  it('reports what the quota actually refused', async () => {
    countAsync('async_quota_refusals');
    countAsync('async_quota_refusals');
    const res = await HANDLERS.getMetrics!(ctx({ principal: admin }), makeDeps());
    expect(res.body).toEqual({
      counters: { async_quota_refusals: 2, credential_nonprimary_kek_reads: 0 },
    });
  });

  /**
   * The KEK rotation signal (subject-document.ts, RUNBOOK). Counted here as well as logged, because
   * the terminating condition for dropping a retired KEK is "this stopped moving" -- which an
   * operator reads off /metrics rather than by scraping logs.
   */
  it('reports credentials opened under a retired KEK, apart from the quota count', async () => {
    countAsync('credential_nonprimary_kek_reads');
    countAsync('credential_nonprimary_kek_reads');
    countAsync('async_quota_refusals');
    const res = await HANDLERS.getMetrics!(ctx({ principal: admin }), makeDeps());
    expect(res.body).toEqual({
      counters: { async_quota_refusals: 1, credential_nonprimary_kek_reads: 2 },
    });
  });

  it('refuses a non-admin with 403, not 404: the route is not a secret, the number is', async () => {
    expect(await codeOf(() => HANDLERS.getMetrics!(ctx({ principal: alice }), makeDeps()))).toBe(
      'forbidden',
    );
  });

  it('refuses a caller with no token at all', async () => {
    expect(await codeOf(() => HANDLERS.getMetrics!(ctx({}), makeDeps()))).toBe('token_required');
  });

  it('does not let a reader mutate the counters', async () => {
    countAsync('async_quota_refusals');
    const body = (await HANDLERS.getMetrics!(ctx({ principal: admin }), makeDeps())).body as {
      counters: Record<string, number>;
    };
    body.counters.async_quota_refusals = 999;
    const again = await HANDLERS.getMetrics!(ctx({ principal: admin }), makeDeps());
    expect(again.body).toEqual({
      counters: { async_quota_refusals: 1, credential_nonprimary_kek_reads: 0 },
    });
  });
});
