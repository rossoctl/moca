// HANDLERS first: turn-handlers.ts and handlers.ts are in a runtime cycle (see gate-sweep.ts), so
// the import that pulls handlers.ts in must come before the modules that re-enter it.
import { HANDLERS } from '../src/handlers.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseDestination } from '../src/egress-destination.js';
import { NotifyStore } from '../src/notify-store.js';
import { NOTIFY_NTFY_CRED, NOTIFY_WEBHOOK_CRED } from '../src/notify-handlers.js';
import { alice, bob, codeOf, ctx, makeDeps } from './helpers/deps.js';

const ALLOW = ['hooks.example.com/moca', 'ntfy.example.com'].map(parseDestination);
const webhook = { kind: 'webhook', url: 'https://hooks.example.com/moca' };
const ntfy = { kind: 'ntfy', url: 'https://ntfy.example.com', topic: 'moca-alice' };

let deps: ReturnType<typeof makeDeps>;

beforeEach(() => {
  const base = makeDeps();
  deps = makeDeps({
    config: { ...base.config, notify: { ...base.config.notify, allow: ALLOW } },
  });
});

const put = (body: unknown, principal = alice) =>
  HANDLERS.putNotifications!(ctx({ principal, body }), deps);
const get = (principal = alice) => HANDLERS.getNotifications!(ctx({ principal }), deps);
const del = (principal = alice) => HANDLERS.deleteNotifications!(ctx({ principal }), deps);

describe('PUT /v1/notifications', () => {
  it('stores the config, mints the webhook secret ONCE, and starts the cursor at now', async () => {
    const res = await put({ sinks: [webhook, { ...ntfy, token: 'tk_1' }] });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.sinks).toEqual([webhook, ntfy]);
    expect(body.states).toEqual(['paused', 'failed']);
    // 32 bytes of hex: the only time this value is ever readable over the API.
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);

    const stored = await deps.notify!.get(alice.sub);
    expect(stored?.sinks).toEqual([webhook, ntfy]);
    // From NOW, not from the start of the log: a subject who configures notifications on Friday is
    // not paged for Thursday's turns.
    expect(stored?.cursor).toBe(await deps.turns!.lastEventId(alice.sub));

    // The secrets are in the credential store, never in Redis.
    const key = (await deps.credentials.get(alice.sub, NOTIFY_WEBHOOK_CRED))?.secret.key;
    expect(key).toBe(body.webhookSecret);
    expect((await deps.credentials.get(alice.sub, NOTIFY_NTFY_CRED))?.secret.token).toBe('tk_1');
    expect(JSON.stringify(stored)).not.toContain(body.webhookSecret as string);
  });

  it('re-PUT rotates the webhook secret and keeps an ntfy token the caller did not resend', async () => {
    const first = (await put({ sinks: [webhook, { ...ntfy, token: 'tk_1' }] })).body as Record<
      string,
      unknown
    >;
    const second = (await put({ sinks: [webhook, ntfy] })).body as Record<string, unknown>;
    expect(second.webhookSecret).not.toBe(first.webhookSecret);
    expect((await deps.credentials.get(alice.sub, NOTIFY_WEBHOOK_CRED))?.secret.key).toBe(
      second.webhookSecret,
    );
    // Not resending the token must not silently un-authenticate the ntfy sink.
    expect((await deps.credentials.get(alice.sub, NOTIFY_NTFY_CRED))?.secret.token).toBe('tk_1');
  });

  it('mints no secret when there is no webhook sink', async () => {
    const res = await put({ sinks: [ntfy] });
    expect((res.body as Record<string, unknown>).webhookSecret).toBeUndefined();
    expect(await deps.credentials.get(alice.sub, NOTIFY_WEBHOOK_CRED)).toBeFalsy();
  });

  it('refuses a url outside the operator allowlist, and refuses everything when it is empty', async () => {
    expect(await codeOf(() => put({ sinks: [{ ...webhook, url: 'https://evil.test/x' }] }))).toBe(
      'invalid_request',
    );
    const closed = makeDeps();
    expect(
      await codeOf(() =>
        HANDLERS.putNotifications!(ctx({ principal: alice, body: { sinks: [webhook] } }), closed),
      ),
    ).toBe('invalid_request');
  });

  it('requires a token', async () => {
    expect(
      await codeOf(() => HANDLERS.putNotifications!(ctx({ body: { sinks: [webhook] } }), deps)),
    ).toBe('token_required');
  });
});

describe('GET /v1/notifications', () => {
  it('404s before anything is configured', async () => {
    expect(await codeOf(get)).toBe('not_found');
  });

  it('returns the config and the bookkeeping, and NEVER a secret', async () => {
    const minted = (await put({ sinks: [webhook, { ...ntfy, token: 'tk_1' }] })).body as Record<
      string,
      unknown
    >;
    const res = await get();
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toMatchObject({
      sinks: [webhook, ntfy],
      states: ['paused', 'failed'],
      failures: 0,
      mutedUntil: 0,
      lastDeliveryAt: 0,
      secretMissing: false,
    });
    expect(JSON.stringify(body)).not.toContain(minted.webhookSecret as string);
    expect(JSON.stringify(body)).not.toContain('tk_1');
  });

  it('reports secretMissing when the config outlived its key', async () => {
    await put({ sinks: [webhook] });
    // The half-configured state a 503 from a Vault- or K8s-backed credential store can leave.
    await deps.credentials.delete(alice.sub, NOTIFY_WEBHOOK_CRED);
    expect((await get()).body).toMatchObject({ secretMissing: true });
  });

  it('is scoped to the caller: one subject never reads another config', async () => {
    await put({ sinks: [webhook] });
    expect(await codeOf(() => get(bob))).toBe('not_found');
  });
});

describe('DELETE /v1/notifications', () => {
  it('removes the config, the index entry and both secrets, and is idempotent', async () => {
    await put({ sinks: [webhook, { ...ntfy, token: 'tk_1' }] });
    expect((await del()).status).toBe(204);
    expect(await deps.notify!.get(alice.sub)).toBeNull();
    expect(await deps.notify!.owners()).toEqual([]);
    expect(await deps.credentials.get(alice.sub, NOTIFY_WEBHOOK_CRED)).toBeFalsy();
    expect(await deps.credentials.get(alice.sub, NOTIFY_NTFY_CRED)).toBeFalsy();
    expect((await del()).status).toBe(204);
  });

  it('does not touch another subject config', async () => {
    await put({ sinks: [webhook] });
    await put({ sinks: [webhook] }, bob);
    await del(bob);
    expect(await deps.notify!.get(alice.sub)).not.toBeNull();
  });
});

describe('the route table', () => {
  it('mounts all three on the harness profile, authenticated and not session-scoped', async () => {
    const { ROUTES } = await import('../src/routes.js');
    const rows = ROUTES.filter((r) => r.path === '/v1/notifications');
    expect(rows.map((r) => r.method).sort()).toEqual(['DELETE', 'GET', 'PUT']);
    for (const r of rows) {
      expect(r.auth).toBe('api');
      expect(r.sessionScoped).toBe(false);
      expect(r.profiles).toContain('harness');
      expect(HANDLERS[r.operationId]).toBeTypeOf('function');
    }
  });
});
