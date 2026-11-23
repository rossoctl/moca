import type { CpDeps } from './handlers.js';
import { allowsUrl, renderNotification } from './notify-config.js';
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

  // shortcut: no `gap` detection. A cursor held through a long mute while the owner's stream passes
  // EVENTS_MAXLEN (500) silently skips the trimmed events instead of reporting them; `GET
  // /v1/events` answers a `gap` frame for exactly this case. Upgrade by checking for one here and
  // widening the summary (or the cursor advance) accordingly.
  const events = await turns.readEvents(subject, cfg.cursor, limit);
  if (events.length === 0) return false;
  // `cursor` is optional on TurnEvent only because a WRITER has no stream id yet; `decodeTurnEvent`
  // always sets it from the entry id, so a read event has one. Asserted rather than defaulted to
  // `cfg.cursor`: that default would write the cursor back unchanged and re-deliver this same batch
  // on every pass -- a quiet loop in place of a loud bug.
  const head = events[events.length - 1]!.cursor!;
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

  // The allowlist is re-checked at SEND time, not only at the PUT that stored the sink: an operator
  // who takes a host OUT of MOCA_NOTIFY_ALLOW must stop this process posting to the sinks saved
  // while it was in, and there is no route an admin can use to edit another subject's config.
  //
  // A now-disallowed sink is DROPPED, not counted as a failed delivery, for the same reason
  // `deliver` drops a webhook with no signing key: no retry re-adds the host to the allowlist, so
  // failing on it would hold the cursor and starve the still-allowed co-sink -- the owner's phone --
  // until `failMax` muted the subject over a sink they cannot fix from their side either. With no
  // allowed sink left it IS a failure, which is the single-sink case the operator docs describe:
  // the cursor holds and `failures`/`mutedUntil` on GET /v1/notifications tells the subject to
  // re-PUT. A subject who keeps a working co-sink is told nothing, deliberately: the operator who
  // narrowed the list is the only one who can widen it again, and `GET` does not expose it.
  const sinks = cfg.sinks.filter((s) => allowsUrl(s.url, deps.config.notify.allow));
  const sentOk =
    sinks.length > 0 &&
    (await deliver(
      { fetchImpl: deps.fetchImpl ?? fetch },
      sinks,
      {
        // The batch's head cursor, not deps.newId(): a retry of this same unadvanced batch (a crash
        // right after this call, or two overlapping passes) must carry the SAME id, or the dedupe
        // advice in notify-send.ts's NotifyPayload comment is not true.
        deliveryId: head,
        timestamp: Math.floor(now / 1000),
        summary: renderNotification(matching, deps.config.notify.baseUrl),
        events: matching,
      },
      await readNotifySecrets(deps, subject),
    ));

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

// Guards against a pass overlapping ITSELF: three owners with hanging sinks can push one pass past
// `intervalMs`, and without this a second `setInterval` tick would re-read and re-deliver the same
// unadvanced batch. Not the two-replica case -- that is the `shortcut:` on sweepNotifications above,
// and a module-level flag does nothing for a second process.
let running = false;

/** Armed from main.ts, exactly as startGateSweep is. `unref` so it never holds the process open. */
export function startNotifySweep(deps: CpDeps, intervalMs = NOTIFY_SWEEP_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    // Nothing may reject out of a setInterval callback on Node 22: the default for an unhandled
    // rejection is to terminate the process, so a Redis blip would restart the control plane every
    // tick instead of just costing one skipped pass.
    void sweepNotifications(deps)
      .catch((err) => console.error('[notify-sweep]', err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
