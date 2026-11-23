import { CpError } from './errors.js';
import type { Destination } from './egress-destination.js';
import { TURN_STATES, type TurnEvent, type TurnState } from './turn-record.js';

/**
 * The #394 notifier's pure core: validation, the egress allowlist test and rendering. No Redis and
 * no HTTP, so the store, the handlers and the sender can each import it without importing one
 * another -- the same rule `turn-record.ts` follows for the turn record.
 */

/**
 * The states a subject may ask to hear about: every terminal state, and nothing else. `queued` and
 * `running` are excluded by CONSTRUCTION rather than by documentation -- `running` fires for every
 * turn that starts, so a deployment that allowed it would page an owner for work they just submitted.
 */
export const NOTIFY_STATES: readonly TurnState[] = TURN_STATES.filter(
  (s) => s !== 'queued' && s !== 'running',
);

/** Paused and failed: the two an away owner can act on. Everything else is opt-in. */
export const DEFAULT_NOTIFY_STATES: readonly TurnState[] = ['paused', 'failed'];

/** At most one of each kind, so one credential name per subject holds one secret. */
const MAX_SINKS = 2;
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOKEN_CHARS = 512;

export interface NotifySink {
  kind: 'webhook' | 'ntfy';
  url: string;
  /** Required for `ntfy`, refused for `webhook`. */
  topic?: string;
}

export interface NotifyConfig {
  sinks: NotifySink[];
  states: TurnState[];
}

/** What the store reads back: the config plus the sweep's own bookkeeping. */
export interface StoredNotifyConfig extends NotifyConfig {
  /** The event-stream id delivery resumes AFTER. */
  cursor: string;
  createdAt: number;
  lastDeliveryAt: number;
  /** CONSECUTIVE failed passes; any success resets it. */
  failures: number;
  mutedUntil: number;
  hourStart: number;
  hourCount: number;
}

/** The token is returned SEPARATELY from the config: it is a secret and never goes in Redis. */
export interface ParsedNotifyPut {
  config: NotifyConfig;
  ntfyToken?: string;
}

function invalid(why: string): never {
  throw new CpError('invalid_request', why);
}

/** A JSON value as a plain object; anything else (array, null, scalar) throws `why`. */
function asObject(v: unknown, why: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) invalid(why);
  return v as Record<string, unknown>;
}

/**
 * Whether a sink URL is one the deployment allows. This is the ONLY SSRF control: without it a
 * user-supplied URL fetched from inside the control plane reaches the instance metadata service
 * (#357), the Redis service and the kube API.
 *
 * shortcut: host-level only -- an allowed name that RESOLVES to a link-local address still gets the
 * request. The same trust model `SH_MODEL_CATALOG_HOSTS` operates under; upgrade when the control
 * plane gains a resolving egress proxy of its own (slice 3's injector).
 */
export function allowsUrl(raw: string, allow: Destination[]): boolean {
  const u = URL.parse(raw);
  // Credentials in the URL would travel to the sink and show up in its logs, and they are also how
  // an allowlist on `hostname` is bypassed in parsers that read the authority less carefully.
  if (!u || u.protocol !== 'https:' || u.username !== '' || u.password !== '') return false;
  const host = u.hostname.toLowerCase();
  const port = u.port === '' ? 443 : Number(u.port);
  return allow.some(
    (d) =>
      d.host === host &&
      d.port === port &&
      // Segment-aware, or a `/moca` prefix would also allow `/mocahijack`.
      (d.pathPrefix === '/' ||
        u.pathname === d.pathPrefix ||
        u.pathname.startsWith(`${d.pathPrefix}/`)),
  );
}

/** The hostname of a value that may not even be a URL -- never the raw value, see its one caller. */
function hostnameOf(raw: unknown): string {
  if (typeof raw !== 'string') return '(not a string)';
  const u = URL.parse(raw);
  return u ? u.hostname : '(unparseable url)';
}

function parseSink(raw: unknown, allow: Destination[]): { sink: NotifySink; token?: string } {
  const s = asObject(raw, 'each sink must be an object');
  if (s.kind !== 'webhook' && s.kind !== 'ntfy') {
    invalid("sink kind must be 'webhook' or 'ntfy'");
  }
  if (typeof s.url !== 'string' || !allowsUrl(s.url, allow)) {
    // The hostname only, never the raw url: a sink url is exactly where someone pastes a token, and
    // this message only reaches the caller's own 400 body, but echoing the thing that was just
    // rejected FOR carrying credentials would be the same mistake with extra steps.
    invalid(
      `sink url must be an https URL allowed by MOCA_NOTIFY_ALLOW, got host '${hostnameOf(s.url)}'`,
    );
  }
  if (s.kind === 'webhook') {
    if (s.topic !== undefined) invalid('a webhook sink takes no topic');
    if (s.token !== undefined) invalid('a webhook sink takes no token; its secret is minted here');
    return { sink: { kind: 'webhook', url: s.url } };
  }
  if (typeof s.topic !== 'string' || !NTFY_TOPIC_RE.test(s.topic)) {
    invalid(`an ntfy sink needs a topic matching ${NTFY_TOPIC_RE.source}`);
  }
  if (s.token !== undefined) {
    if (typeof s.token !== 'string' || s.token.length > MAX_TOKEN_CHARS) {
      invalid(`an ntfy token must be a string of at most ${MAX_TOKEN_CHARS} characters`);
    }
    // An explicitly-present empty token is how a user tries to clear it -- but an absent `token` is
    // "left alone", so a silently-kept '' would quietly keep auth the user just asked to drop.
    if (s.token === '') {
      invalid('an empty ntfy token is refused; DELETE /v1/notifications is how you clear it');
    }
  }
  return {
    sink: { kind: 'ntfy', url: s.url, topic: s.topic },
    ...(s.token !== undefined ? { token: s.token as string } : {}),
  };
}

/** `PUT /v1/notifications`'s body. Throws CpError('invalid_request') naming the field at fault. */
export function parseNotifyConfig(body: unknown, allow: Destination[]): ParsedNotifyPut {
  // Checked FIRST, and by naming the variable: a deployment that never enabled notifications must
  // not be told its sink url is wrong. Fail-closed, like the janitor and installer tokens.
  if (allow.length === 0) {
    invalid('notifications are not enabled on this deployment: MOCA_NOTIFY_ALLOW is unset');
  }
  const b = asObject(body, 'body must be an object');
  if (!Array.isArray(b.sinks) || b.sinks.length === 0 || b.sinks.length > MAX_SINKS) {
    invalid(`sinks must be an array of 1 to ${MAX_SINKS} entries`);
  }
  const sinks: NotifySink[] = [];
  let ntfyToken: string | undefined;
  for (const raw of b.sinks) {
    const { sink, token } = parseSink(raw, allow);
    if (sinks.some((s) => s.kind === sink.kind)) invalid(`at most one '${sink.kind}' sink`);
    sinks.push(sink);
    if (token) ntfyToken = token;
  }

  let states = [...DEFAULT_NOTIFY_STATES];
  if (b.states !== undefined) {
    if (!Array.isArray(b.states) || b.states.length === 0) {
      invalid('states must be a non-empty array when present');
    }
    for (const s of b.states) {
      if (typeof s !== 'string' || !(NOTIFY_STATES as readonly string[]).includes(s)) {
        invalid(`states must be drawn from ${NOTIFY_STATES.join(', ')}, got '${String(s)}'`);
      }
    }
    // Deduped and ordered by TURN_STATES, so what is stored and what a GET returns cannot depend on
    // the order the client happened to send.
    states = NOTIFY_STATES.filter((s) => (b.states as string[]).includes(s));
  }
  return { config: { sinks, states }, ...(ntfyToken ? { ntfyToken } : {}) };
}

export interface Rendered {
  title: string;
  message: string;
  /** ntfy's 1-5 scale: 4 (high) when something is waiting on a human, else 3 (default). */
  priority: number;
  tags: string[];
  /** Present only when the batch holds a `paused` event AND the deployment set a base url. */
  approveUrl?: string;
}

/**
 * One batch of events as a human reads it, for BOTH sinks -- so a webhook payload's summary and an
 * ntfy push cannot describe the same batch differently.
 *
 * The gate SUMMARY is available with no extra read because #392 carries it on the event
 * (`leaf-job-runner.ts:315` puts `result.gate.summary` there). `proposed_action` is NOT on the
 * event, so a notification cannot offer it -- the approval page reads the gate itself.
 *
 * Only the FIRST `paused` event in the batch (`events.find`) contributes its gate text and approve
 * link; a second paused turn coalesced into the same batch shows up only in the title's count.
 */
export function renderNotification(events: TurnEvent[], baseUrl?: string): Rendered {
  const paused = events.find((e) => e.state === 'paused');
  const failed = events.find((e) => e.state === 'failed');
  const counts = new Map<TurnState, number>();
  for (const e of events) counts.set(e.state, (counts.get(e.state) ?? 0) + 1);

  const title =
    events.length === 1
      ? `moca: turn ${events[0]!.state}`
      : `moca: ${NOTIFY_STATES.filter((s) => counts.has(s))
          .map((s) => `${counts.get(s)} ${s}`)
          .join(', ')}`;
  const message = paused?.gate ?? (failed?.reason ? `failed: ${failed.reason}` : '');

  const link = paused && baseUrl ? approveUrl(baseUrl, paused) : undefined;
  return {
    title,
    message:
      message !== ''
        ? message
        : `${events.length} update${events.length === 1 ? '' : 's'} on your subagents`,
    priority: paused ? 4 : 3,
    tags: paused ? ['warning'] : failed ? ['x'] : ['white_check_mark'],
    ...(link ? { approveUrl: link } : {}),
  };
}

/**
 * The deep link (#394 scope item 4): NO bearer token in the URL, ever. It names the session and the
 * turn only -- the event carries no gate id, and the approval page resolves the gate itself, which
 * is also the correct thing to do because a gate id is session state and can advance.
 *
 * shortcut: this route does not exist yet -- the login-gated approval page is B8b -- so the link
 * 404s until that lands. Upgrade: nothing to change here when it does.
 */
function approveUrl(baseUrl: string, e: TurnEvent): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/approve?session=${encodeURIComponent(e.sessionId)}&turn=${encodeURIComponent(e.turnId)}`;
}
