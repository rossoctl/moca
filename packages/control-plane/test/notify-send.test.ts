import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { renderNotification } from '../src/notify-config.js';
import { deliver, sendNtfy, sendWebhook, signWebhook } from '../src/notify-send.js';
import type { NotifyPayload } from '../src/notify-send.js';
import type { TurnEvent } from '../src/turn-record.js';

const KEY = 'ab'.repeat(32);
const webhook = { kind: 'webhook' as const, url: 'https://hooks.example.com/moca' };
const ntfy = { kind: 'ntfy' as const, url: 'https://ntfy.example.com', topic: 'moca-alice' };

const events: TurnEvent[] = [
  {
    cursor: '5-0',
    ts: 1_000,
    sessionId: 's1',
    turnId: 't1',
    state: 'paused',
    attempts: 1,
    gate: 'ship it?',
  },
];
const payload = (): NotifyPayload => ({
  deliveryId: 'd-1',
  timestamp: 1_757_000_000,
  summary: renderNotification(events, 'https://moca.example.com'),
  events,
});

// A 204 must carry a null body, not '': the Fetch spec forbids a body on a null-body status, and
// this repo's other fetch tests (e.g. mocactl/test/control-plane.test.ts) use `null` for this reason.
const ok = () => vi.fn(async () => new Response(null, { status: 204 }));
const deps = (fetchImpl: unknown) => ({ fetchImpl: fetchImpl as typeof fetch });
const callOf = (f: { mock: { calls: unknown[][] } }, i = 0) =>
  f.mock.calls[i] as unknown as [string, RequestInit];

describe('sendWebhook', () => {
  it('signs `<timestamp>.<rawBody>` with the subject key, and sends what it signed', async () => {
    const f = ok();
    expect(await sendWebhook(deps(f), webhook, payload(), KEY)).toBe(true);

    const [url, init] = callOf(f);
    expect(url).toBe(webhook.url);
    expect(init.method).toBe('POST');
    const h = new Headers(init.headers);
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('x-moca-delivery')).toBe('d-1');
    expect(h.get('x-moca-timestamp')).toBe('1757000000');

    // The acceptance criterion: verify the signature the way a RECEIVER would -- from the bytes on
    // the wire, with no help from the module under test.
    const expected = createHmac('sha256', KEY)
      .update(`1757000000.${init.body as string}`)
      .digest('hex');
    expect(h.get('x-moca-signature')).toBe(`sha256=${expected}`);

    const body = JSON.parse(init.body as string);
    expect(body.events[0].gate).toBe('ship it?');
    expect(body.summary.approveUrl).toBe('https://moca.example.com/approve?session=s1&turn=t1');
    // No secret travels in the body or the URL (#394 scope item 4).
    expect(init.body as string).not.toContain(KEY);
  });

  it('a different body, timestamp or key gives a different signature', () => {
    const a = signWebhook(KEY, 1, '{"a":1}');
    expect(signWebhook(KEY, 2, '{"a":1}')).not.toBe(a);
    expect(signWebhook(KEY, 1, '{"a":2}')).not.toBe(a);
    expect(signWebhook('cd'.repeat(32), 1, '{"a":1}')).not.toBe(a);
  });

  it('counts a non-2xx and a throw as failures, and never throws', async () => {
    const bad = vi.fn(async () => new Response('nope', { status: 500 }));
    expect(await sendWebhook(deps(bad), webhook, payload(), KEY)).toBe(false);

    const threw = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await sendWebhook(deps(threw), webhook, payload(), KEY)).toBe(false);
  });

  it('refuses to send unsigned when the key is missing', async () => {
    const f = ok();
    expect(await sendWebhook(deps(f), webhook, payload(), undefined)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('sendNtfy', () => {
  it('POSTs the JSON form to the sink url exactly, with the topic in the body', async () => {
    const f = ok();
    expect(await sendNtfy(deps(f), ntfy, payload(), 'tk_1')).toBe(true);
    const [url, init] = callOf(f);
    // The JSON form, not POST /<topic> with X-Title: a gate summary is arbitrary UTF-8, and the
    // header form would need RFC 2047 encoding.
    expect(url).toBe(ntfy.url);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      topic: 'moca-alice',
      title: 'moca: turn paused',
      message: 'ship it?',
      priority: 4,
      tags: ['warning'],
    });
    expect(body.actions).toEqual([
      {
        action: 'view',
        label: 'Approve',
        url: 'https://moca.example.com/approve?session=s1&turn=t1',
      },
    ]);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tk_1');
  });

  it('publishes anonymously when no token is configured, and omits actions with no link', async () => {
    const f = ok();
    const p = { ...payload(), summary: renderNotification(events) };
    expect(await sendNtfy(deps(f), ntfy, p, undefined)).toBe(true);
    const [, init] = callOf(f);
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(JSON.parse(init.body as string).actions).toBeUndefined();
  });

  it('keeps an operator path prefix instead of discarding it', async () => {
    const f = ok();
    const prefixed = { ...ntfy, url: 'https://ntfy.example.com/moca' };
    expect(await sendNtfy(deps(f), prefixed, payload(), 'tk_1')).toBe(true);
    const [url] = callOf(f);
    expect(url).toBe('https://ntfy.example.com/moca');
  });
});

describe('post (redirect handling, both sinks share this)', () => {
  it('passes redirect: "error" so undici never chases a sink to an unchecked host', async () => {
    const f = ok();
    await sendWebhook(deps(f), webhook, payload(), KEY);
    await sendNtfy(deps(f), ntfy, payload(), 'tk_1');
    expect(callOf(f, 0)[1].redirect).toBe('error');
    expect(callOf(f, 1)[1].redirect).toBe('error');
  });

  it('a sink answering a redirect fails the delivery and never reaches the redirect target', async () => {
    // undici throws on a 3xx when redirect: 'error' is set, rather than returning a Response: this
    // is the shape its real fetch takes, and it means `deliver` sees exactly the same TypeError a
    // network failure would.
    const redirecting = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await sendWebhook(deps(redirecting), webhook, payload(), KEY)).toBe(false);
    expect(await sendNtfy(deps(redirecting), ntfy, payload(), 'tk_1')).toBe(false);
    expect(redirecting).toHaveBeenCalledTimes(2); // the sink's own url only, never a second hop
  });
});

describe('deliver', () => {
  it('sends to every sink and succeeds only when all of them accept', async () => {
    const f = ok();
    expect(
      await deliver(deps(f), [webhook, ntfy], payload(), { webhookKey: KEY, ntfyToken: 'tk' }),
    ).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);

    const half = vi.fn(async (u: unknown) =>
      String(u).includes('ntfy')
        ? new Response('', { status: 500 })
        : new Response(null, { status: 204 }),
    );
    expect(await deliver(deps(half), [webhook, ntfy], payload(), { webhookKey: KEY })).toBe(false);
    // Both were still attempted: one dead sink must not silence the other.
    expect(half).toHaveBeenCalledTimes(2);
  });

  it('a webhook with no signing key does not hold the batch back from the ntfy sink', async () => {
    // The `secretMissing` state. No retry can fix it, so counting it as a failure would hold the
    // cursor and re-push this same batch to the phone every pass until the subject was muted.
    const f = ok();
    expect(await deliver(deps(f), [webhook, ntfy], payload(), { ntfyToken: 'tk' })).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(callOf(f)[0]).toContain('ntfy');
  });

  it('fails when NOTHING could be sent, rather than reporting an empty success', async () => {
    // A webhook alone with no key: `every()` over the attempted-sink list would be vacuously true
    // and drop the batch silently. The cursor must hold and `failures` must say so.
    const f = ok();
    expect(await deliver(deps(f), [webhook], payload(), {})).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
