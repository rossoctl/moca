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
  /** Unique per attempt. A receiver dedupes on it; at-least-once is the contract (ADR-0015). */
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
  return post(deps, new URL('/', sink.url).toString(), {
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
 * shortcut: the verdict is all-or-nothing, so a permanently broken webhook holds the cursor and the
 * ntfy sink is pushed the same events again next pass. Upgrade to a per-sink cursor if a deployment
 * ever runs more than one sink per kind; with at most two, re-pushing beats the bookkeeping.
 */
export async function deliver(
  deps: SendDeps,
  sinks: NotifySink[],
  payload: NotifyPayload,
  secrets: { webhookKey?: string; ntfyToken?: string },
): Promise<boolean> {
  const results = await Promise.all(
    sinks.map((s) =>
      s.kind === 'webhook'
        ? sendWebhook(deps, s, payload, secrets.webhookKey)
        : sendNtfy(deps, s, payload, secrets.ntfyToken),
    ),
  );
  return results.every(Boolean);
}
