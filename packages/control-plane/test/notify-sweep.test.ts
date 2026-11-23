// HANDLERS first: the handlers.ts <-> turn-handlers.ts runtime cycle (see gate-sweep.ts).
import { HANDLERS } from '../src/handlers.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDestination } from '../src/egress-destination.js';
import { NOTIFY_WEBHOOK_CRED } from '../src/notify-handlers.js';
import { NotifyStore } from '../src/notify-store.js';
import { sweepNotifications } from '../src/notify-sweep.js';
import { encodeTurnEvent, ownerEventsKey, type TurnEvent } from '../src/turn-record.js';
import { alice, ctx, makeDeps, NOW_MS } from './helpers/deps.js';
import { fakeRedis } from './helpers/fake-redis.js';
import { TurnStore } from '../src/turn-store.js';

const ALLOW = ['hooks.example.com/moca', 'ntfy.example.com'].map(parseDestination);
const webhook = { kind: 'webhook', url: 'https://hooks.example.com/moca' };

let fake: ReturnType<typeof fakeRedis>;
let deps: ReturnType<typeof makeDeps>;
let sent: ReturnType<typeof vi.fn>;
let now = NOW_MS;

const ev = (over: Partial<TurnEvent> = {}): TurnEvent => ({
  ts: now,
  sessionId: 's1',
  turnId: 't1',
  state: 'paused',
  attempts: 1,
  gate: 'ship it?',
  ...over,
});

/** Append straight to the owner's stream: what TurnStore.emit writes on a transition. */
const emit = async (e: TurnEvent) =>
  fake.redis.xAdd(ownerEventsKey(alice.sub), '*', encodeTurnEvent(e));

beforeEach(() => {
  now = NOW_MS;
  fake = fakeRedis();
  sent = vi.fn(async () => new Response(null, { status: 204 }));
  const base = makeDeps();
  deps = makeDeps({
    now: () => now,
    fetchImpl: sent as unknown as typeof fetch,
    config: {
      ...base.config,
      notify: { ...base.config.notify, allow: ALLOW, baseUrl: 'https://moca.example.com' },
    },
    notify: new NotifyStore(fake.redis),
    turns: new TurnStore(fake.redis, { resultTtlSeconds: 86_400, ttlMarginSeconds: 3_600 }),
  });
});

const configure = (body: unknown = { sinks: [webhook] }) =>
  HANDLERS.putNotifications!(ctx({ principal: alice, body }), deps);

describe('sweepNotifications', () => {
  it('delivers a matching event once and resumes after it', async () => {
    await configure();
    await emit(ev());
    expect(await sweepNotifications(deps)).toBe(1);
    expect(sent).toHaveBeenCalledTimes(1);

    // The cursor moved, so a second pass sends nothing.
    now += 60_000;
    expect(await sweepNotifications(deps)).toBe(0);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a state the subject did not ask about, but still advances', async () => {
    await configure();
    await emit(ev({ state: 'solved', gate: undefined }));
    expect(await sweepNotifications(deps)).toBe(0);
    expect(sent).not.toHaveBeenCalled();
    // Advanced anyway: a stream of unwanted states must not pin the cursor behind them forever.
    const cfg = await deps.notify!.get(alice.sub);
    expect(cfg?.cursor).toBe(await deps.turns!.lastEventId(alice.sub));
  });

  it('coalesces everything since the cursor into ONE delivery', async () => {
    await configure();
    await emit(ev({ turnId: 't1' }));
    await emit(ev({ turnId: 't2', state: 'failed', gate: undefined, reason: 'budget' }));
    expect(await sweepNotifications(deps)).toBe(1);
    expect(sent).toHaveBeenCalledTimes(1);
    const body = JSON.parse((sent.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
    expect(body.summary.title).toBe('moca: 1 paused, 1 failed');
  });

  it('HOLDS the cursor when delivery fails, so the next pass retries', async () => {
    await configure();
    await emit(ev());
    const before = (await deps.notify!.get(alice.sub))!.cursor;
    sent.mockImplementation(async () => new Response('', { status: 500 }));

    expect(await sweepNotifications(deps)).toBe(0);
    let cfg = await deps.notify!.get(alice.sub);
    expect(cfg?.cursor).toBe(before);
    expect(cfg?.failures).toBe(1);

    now += 60_000;
    sent.mockImplementation(async () => new Response(null, { status: 204 }));
    expect(await sweepNotifications(deps)).toBe(1);
    cfg = await deps.notify!.get(alice.sub);
    expect(cfg?.failures).toBe(0);
    expect(cfg?.cursor).not.toBe(before);
  });

  it('mutes a subject for an hour after MOCA_NOTIFY_FAIL_MAX consecutive failures', async () => {
    deps.config.notify.failMax = 2;
    deps.config.notify.minIntervalS = 0;
    await configure();
    sent.mockImplementation(async () => new Response('', { status: 500 }));
    await emit(ev());

    await sweepNotifications(deps);
    now += 1_000;
    await sweepNotifications(deps);
    expect((await deps.notify!.get(alice.sub))?.mutedUntil).toBe(now + 3_600_000);

    sent.mockClear();
    now += 1_000;
    expect(await sweepNotifications(deps)).toBe(0);
    expect(sent).not.toHaveBeenCalled(); // muted: not even attempted

    // And a re-PUT un-mutes, which is the documented way back.
    await configure();
    expect((await deps.notify!.get(alice.sub))?.mutedUntil).toBe(0);
  });

  it('honours the minimum interval between deliveries', async () => {
    deps.config.notify.minIntervalS = 300;
    await configure();
    await emit(ev());
    expect(await sweepNotifications(deps)).toBe(1);
    await emit(ev({ turnId: 't2' }));
    now += 10_000;
    expect(await sweepNotifications(deps)).toBe(0); // too soon; the event is not lost
    now += 300_000;
    expect(await sweepNotifications(deps)).toBe(1);
  });

  it('mutes rather than pages past the hourly cap, and keeps the stream moving', async () => {
    deps.config.notify.perHour = 1;
    deps.config.notify.minIntervalS = 0;
    await configure();
    await emit(ev());
    expect(await sweepNotifications(deps)).toBe(1);

    await emit(ev({ turnId: 't2' }));
    now += 1_000;
    expect(await sweepNotifications(deps)).toBe(0);
    const cfg = await deps.notify!.get(alice.sub);
    expect(cfg?.mutedUntil).toBeGreaterThan(now);
    // The cursor moved past the dropped batch: the cap protects the sink, so the alternative is an
    // unbounded backlog delivered an hour stale.
    expect(cfg?.cursor).toBe(await deps.turns!.lastEventId(alice.sub));
  });

  it('does nothing at all when the deployment did not enable notifications', async () => {
    await configure();
    await emit(ev());
    deps.config.notify.allow = [];
    expect(await sweepNotifications(deps)).toBe(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it('one owner failure does not stop the pass', async () => {
    await configure();
    await emit(ev());
    // A config whose secret is gone: sendWebhook refuses to send unsigned, so this owner fails.
    await deps.credentials.delete(alice.sub, NOTIFY_WEBHOOK_CRED);
    await expect(sweepNotifications(deps)).resolves.toBe(0);
  });

  it('never puts a secret in the payload', async () => {
    const minted = (await configure({ sinks: [webhook] })).body as Record<string, unknown>;
    await emit(ev());
    await sweepNotifications(deps);
    const call = sent.mock.calls[0]!;
    expect(JSON.stringify(call)).not.toContain(minted.webhookSecret as string);
  });
});
