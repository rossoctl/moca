import { createHmac } from 'node:crypto';
import type { NotifySink, Rendered } from './notify-config.js';
import type { TurnEvent } from './turn-record.js';

/**
 * Delivery for #394: the ONLY module here that touches the network, so the sweep stays testable
 * without a fetch stub and an SSRF review has one file to read.
 *
 * Nothing in here throws. A sink is a third party the control plane cannot control, so a failure is
 * a RETURN VALUE -- the sweep's cursor decision depends on it, and an exception escaping into the
 * sweep would let one broken webhook stop every later owner's pass.
 */

const DEFAULT_TIMEOUT_MS = 5_000;

export interface NotifyPayload {
  /**
   * The batch's head cursor (the newest event's stream id), not a fresh id per attempt: a retry of
   * the same unadvanced batch -- a crash between `deliver` and `advance`, or two overlapping passes
   * -- must carry the SAME id, or a receiver that dedupes on it (at-least-once is the contract,
   * ADR-0015) accepts the duplicate.
   *
   * Dedupe therefore holds for a retry of an IDENTICAL batch. If events arrive between the failed
   * attempt and the retry the batch grows, its head moves, and the receiver sees a new id carrying
   * events it already handled -- one duplicate. Deliberately not fixed by keying on the batch's
   * START cursor, which is stable across a growing batch: a deduping receiver would then drop the
   * grown retry and the events added to it would never be delivered. Duplicates beat losses.
   */
  deliveryId: string;
  /** UNIX SECONDS, not ms: it is signed, and a receiver rejects a stale one by comparing to now. */
  timestamp: number;
  summary: Rendered;
  events: TurnEvent[];
}

export interface SendDeps {
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

/**
 * `HMAC-SHA256(key, "<timestamp>.<rawBody>")`, hex, no prefix. The timestamp is INSIDE the signed
 * string so a captured body cannot be replayed later under a fresh header -- which is the whole
 * reason the body is signed rather than merely sent.
 */
export function signWebhook(key: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', key).update(`${timestamp}.${rawBody}`).digest('hex');
}

async function post(deps: SendDeps, url: string, init: RequestInit): Promise<boolean> {
  try {
    const res = await deps.fetchImpl(url, {
      ...init,
      // A sink that accepts the connection and never answers would otherwise hold the sweep for a
      // whole interval. No retry here: the cursor does not advance, so the next pass IS the retry.
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      // undici follows redirects by default. An allowlisted host that answers 302 to, say, the
      // instance metadata service would otherwise be chased with nothing re-checking the allowlist
      // on the new URL -- exactly the SSRF hole `allowsUrl` exists to close. A redirect fails the
      // delivery instead; the cursor holds, so the next pass is the retry, same as any other failure.
      redirect: 'error',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendWebhook(
  deps: SendDeps,
  sink: NotifySink,
  payload: NotifyPayload,
  key: string | undefined,
): Promise<boolean> {
  // Fail rather than send unsigned. A receiver that verifies cannot tell "the control plane lost my
  // key" from "someone else is posting to my endpoint", so it must never see an unsigned body.
  if (!key) return false;
  const body = JSON.stringify(payload);
  return post(deps, sink.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-moca-delivery': payload.deliveryId,
      'x-moca-timestamp': String(payload.timestamp),
      'x-moca-signature': `sha256=${signWebhook(key, payload.timestamp, body)}`,
    },
    body,
  });
}

/**
 * ntfy's JSON publish form: POST to the server ROOT with `topic` in the body. Chosen over
 * `POST /<topic>` with `X-Title`/`X-Message` because a gate summary is arbitrary UTF-8 and the
 * header form would need RFC 2047 encoding.
 *
 * The token is optional: ntfy publishes anonymously by default, where the topic name IS the
 * password. That is the self-hosted default, so requiring a token would fail the common case.
 */
export async function sendNtfy(
  deps: SendDeps,
  sink: NotifySink,
  payload: NotifyPayload,
  token: string | undefined,
): Promise<boolean> {
  const { title, message, priority, tags, approveUrl } = payload.summary;
  // POST to the stored url exactly, not its origin: `allowsUrl` approved this path (possibly a
  // prefix the operator chose deliberately), and ntfy's JSON publish form works at whatever base
  // path the server is mounted on. Discarding the path would defeat that prefix.
  return post(deps, sink.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      topic: sink.topic,
      title,
      message,
      priority,
      tags,
      // A `view` action, so the phone taps through to the login-gated approval page (B8b) and never
      // to anything carrying a credential.
      ...(approveUrl ? { actions: [{ action: 'view', label: 'Approve', url: approveUrl }] } : {}),
    }),
  });
}

/**
 * Every sink, then one verdict. All sinks are attempted even after one fails: a dead webhook must
 * not silence the push that actually reaches the phone.
 *
 * shortcut: the verdict is all-or-nothing for sinks that were ATTEMPTED, so one sink's transport
 * failure re-pushes the batch to the other next pass. Upgrade to a per-sink cursor if that
 * duplicate ever matters more than the bookkeeping; with at most two sinks it does not.
 */
export async function deliver(
  deps: SendDeps,
  sinks: NotifySink[],
  payload: NotifyPayload,
  secrets: { webhookKey?: string; ntfyToken?: string },
): Promise<boolean> {
  // A webhook with no signing key can never be sent to -- `sendWebhook` refuses to send unsigned --
  // so it is excluded from the verdict rather than failing it. Counted as a failure it would hold
  // the cursor, and the ntfy sink that DOES reach the phone would be re-pushed the same batch every
  // pass until `failMax` muted the subject. `secretMissing` on `GET /v1/notifications` is this
  // sink's signal, and re-PUTting resets the cursor to now anyway, so holding it buys it nothing.
  const sendable = sinks.filter((s) => s.kind !== 'webhook' || secrets.webhookKey !== undefined);
  // Nothing can be sent at all: a plain failure, so the cursor holds and `failures` says so. Not
  // `every()` over the empty array, which would report success and drop the batch silently.
  if (sendable.length === 0) return false;
  const results = await Promise.all(
    sendable.map((s) =>
      s.kind === 'webhook'
        ? sendWebhook(deps, s, payload, secrets.webhookKey)
        : sendNtfy(deps, s, payload, secrets.ntfyToken),
    ),
  );
  return results.every(Boolean);
}
