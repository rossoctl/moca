import type { CpDeps } from './handlers.js';
import { renderNotification } from './notify-config.js';
// `notify-handlers.js` imports TYPES from handlers.js only, like turn-handlers.js, so reaching it
// from here cannot re-enter the handlers cycle. Keep it that way.
import { readNotifySecrets } from './notify-handlers.js';
import type { NotifyProgress, NotifyStore } from './notify-store.js';
import { deliver } from './notify-send.js';
import type { StoredNotifyConfig } from './notify-config.js';
import type { TurnStore } from './turn-store.js';

/**
 * The notifier (#394): one timer in the control plane that reads each configured owner's #392 event
 * stream and pushes what matches.
 *
 * Why a sweep and not an emit from TurnStore.emit: `emit` runs on the state-write path, once per
 * replica, with no retry and no rate limit. Network I/O there would make a slow webhook a slow
 * turn. Here it is a timer whose worst case is one late notification.
 */
export const NOTIFY_SWEEP_INTERVAL_MS = 10_000;

/** Events read per owner per pass. Bounds one pass's work, not the backlog. */
const NOTIFY_BATCH = 20;

const HOUR_MS = 3_600_000;

/**
 * Notify every owner with something to say. Returns how many were notified by THIS pass.
 *
 * shortcut: no per-owner claim. Two control-plane replicas sweeping the same owner in one pass
 * would both deliver the batch, with different `deliveryId`s. Accepted because every deploy target
 * runs exactly one control-plane replica (`deploy/k8s/base/control-plane.yaml` `replicas: 1`; the
 * vm and compose targets run one process). Upgrade to `claimGate`'s ZREM-as-CAS over a due zset
 * when a target scales the control plane out.
 */
export async function sweepNotifications(deps: CpDeps, limit = NOTIFY_BATCH): Promise<number> {
  const { notify, turns } = deps;
  // Fail-closed: with no allowlist the feature is off, so there is nothing to read and no URL this
  // process would be willing to fetch anyway.
  if (!notify || !turns || deps.config.notify.allow.length === 0) return 0;
  let notified = 0;
  for (const subject of await notify.owners()) {
    try {
      if (await sweepOne(deps, notify, turns, subject, limit)) notified++;
    } catch {
      // One owner's Redis error, credential-store 503 or malformed config must not stop the pass:
      // the next owner in the index is a different person's phone.
    }
  }
  return notified;
}

async function sweepOne(
  deps: CpDeps,
  notify: NotifyStore,
  turns: TurnStore,
  subject: string,
  limit: number,
): Promise<boolean> {
  const now = deps.now();
  const cfg = await notify.get(subject);
  // Indexed with no config: a crashed PUT, or a hash whose schema this build does not read. The
  // next PUT or DELETE reconciles the index; sweeping it costs one HGETALL.
  if (!cfg) return false;
  if (cfg.mutedUntil > now) return false;
  if (now - cfg.lastDeliveryAt < deps.config.notify.minIntervalS * 1000) return false;

  const events = await turns.readEvents(subject, cfg.cursor, limit);
  if (events.length === 0) return false;
  const head = events[events.length - 1]!.cursor ?? cfg.cursor;
  const matching = events.filter((e) => cfg.states.includes(e.state));

  // Nothing wanted in this batch: advance anyway. A subject who asked for `paused` only must not
  // have their cursor pinned behind a wall of `responded`s they will never be told about.
  if (matching.length === 0) {
    await notify.advance(subject, { ...progressOf(cfg), cursor: head });
    return false;
  }

  const window = hourWindow(cfg, now);
  if (window.hourCount >= deps.config.notify.perHour) {
    // Over the cap: mute for the rest of the window and move past the batch.
    //
    // shortcut: those events are not re-sent. The alternative -- holding the cursor -- turns a
    // rate limit into an unbounded backlog that pages the owner with hour-old news, and `mutedUntil`
    // on `GET /v1/notifications` is what tells them it happened. Upgrade when a subject needs a
    // guarantee of delivery rather than of recency.
    await notify.advance(subject, {
      ...progressOf(cfg),
      ...window,
      cursor: head,
      mutedUntil: window.hourStart + HOUR_MS,
    });
    return false;
  }

  const sentOk = await deliver(
    { fetchImpl: deps.fetchImpl ?? fetch },
    cfg.sinks,
    {
      deliveryId: deps.newId(),
      timestamp: Math.floor(now / 1000),
      summary: renderNotification(matching, deps.config.notify.baseUrl),
      events: matching,
    },
    await readNotifySecrets(deps, subject),
  );

  if (!sentOk) {
    const failures = cfg.failures + 1;
    // The cursor is HELD, so the next pass is the retry -- no retry queue, no backoff state.
    await notify.advance(subject, {
      ...progressOf(cfg),
      ...window,
      failures,
      ...(failures >= deps.config.notify.failMax ? { mutedUntil: now + HOUR_MS } : {}),
    });
    return false;
  }

  await notify.advance(subject, {
    ...window,
    cursor: head,
    lastDeliveryAt: now,
    failures: 0,
    mutedUntil: 0,
    hourCount: window.hourCount + 1,
  });
  return true;
}

const progressOf = (c: StoredNotifyConfig): NotifyProgress => ({
  cursor: c.cursor,
  lastDeliveryAt: c.lastDeliveryAt,
  failures: c.failures,
  mutedUntil: c.mutedUntil,
  hourStart: c.hourStart,
  hourCount: c.hourCount,
});

/** A fixed window, not a sliding one: two fields instead of a list of timestamps. */
function hourWindow(c: StoredNotifyConfig, now: number): { hourStart: number; hourCount: number } {
  return now - c.hourStart >= HOUR_MS
    ? { hourStart: now, hourCount: 0 }
    : { hourStart: c.hourStart, hourCount: c.hourCount };
}

/** Armed from main.ts, exactly as startGateSweep is. `unref` so it never holds the process open. */
export function startNotifySweep(deps: CpDeps, intervalMs = NOTIFY_SWEEP_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    void sweepNotifications(deps);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
