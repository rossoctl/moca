import { beforeEach, describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { ROUTES } from '../src/routes.js';
import { countAsync, resetAsyncCounters } from '../src/counters.js';
import { makeDeps, ctx, admin, alice, codeOf } from './helpers/deps.js';

describe('GET /metrics', () => {
  beforeEach(() => resetAsyncCounters());

  it('is declared once, on the harness profile only', () => {
    const route = ROUTES.filter((r) => r.path === '/metrics');
    expect(route).toHaveLength(1);
    expect(route[0]).toMatchObject({
      method: 'GET',
      auth: 'api',
      sessionScoped: false,
      operationId: 'getMetrics',
      profiles: ['harness'],
    });
  });

  it('reports zero before any refusal', async () => {
    const res = await HANDLERS.getMetrics!(ctx({ principal: admin }), makeDeps());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ counters: { async_quota_refusals: 0 } });
  });

  it('reports what the quota actually refused', async () => {
    countAsync('async_quota_refusals');
    countAsync('async_quota_refusals');
    const res = await HANDLERS.getMetrics!(ctx({ principal: admin }), makeDeps());
    expect(res.body).toEqual({ counters: { async_quota_refusals: 2 } });
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
    expect(again.body).toEqual({ counters: { async_quota_refusals: 1 } });
  });
});
