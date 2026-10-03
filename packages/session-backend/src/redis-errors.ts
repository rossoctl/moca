// packages/session-backend/src/redis-errors.ts
import { redactUrl } from './redact-url.js';

/** The slice of a node-redis client this needs: it is an EventEmitter. */
type ErrorEmitter = { on(event: 'error', listener: (err: unknown) => void): unknown };

/** What `createClient` needs to make a long-lived client neither crash nor hang. */
export interface ResilientClientOptions {
  url: string;
  socket: { reconnectStrategy: (retries: number) => number | Error };
}

/** Roughly six seconds of retrying before giving up — long enough for a Redis container to start. */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Construction options that bound the reconnect, which is the OTHER HALF of `swallowRedisErrors`.
 *
 * These two must travel together, because each alone is a different bug:
 *
 *  - Without the listener, an `'error'` emitted on the client is an uncaught exception and the process
 *    exits 1. That is what killed a supervisor worker when a Redis container was recreated under it,
 *    and an E11 relay (where nothing restarts it, so the run was lost).
 *  - With the listener but node-redis's DEFAULT strategy, the listener consumes the very error that
 *    used to make a failed `connect()` reject, so the attempt retries forever and `connect()` never
 *    settles. Probed on the pinned redis 6.2.1 against a dead port: no listener rejects in ~1 ms,
 *    listener-only is still pending at 6 s, listener plus this bound rejects with
 *    `ReconnectStrategyError`.
 *
 *    Two figures, and it matters which is quoted. A REFUSED port returns `ECONNREFUSED` at once, so
 *    only the delays below accumulate: at THIS bound ~5.5 s, the sum of `min(retries * 100, 1000)`
 *    over retries 0..10 (measured 5537 ms). The ~210 ms an earlier revision of this note quoted was a
 *    probe at a REDUCED bound -- the `maxReconnectAttempts` test seam -- and is an order of magnitude
 *    out for the default (measured: max=0 -> 4 ms, max=1 -> 105 ms, max=10 -> 5537 ms). A black-holed
 *    SYN -- a Service with no ready endpoints, or a NetworkPolicy drop, which is the shape to expect in
 *    a cluster -- instead pays the full `connectTimeout` per attempt (5 s by default; `#createSocket`
 *    arms `socket.setTimeout` and destroys with `ConnectionTimeoutError`, socket.js:278-284), so twelve
 *    attempts is ~60 s to reject. Still bounded, still loud, still re-armed -- but size nothing against
 *    the refused-port number. Left as the 5 s default deliberately: a tighter `connectTimeout` would make a Redis
 *    that merely takes >1 s to accept (cold start, TLS, cross-AZ DNS) exhaust the bound on timeouts
 *    alone and never connect at all, trading a slow correct failure for a permanent one.
 *
 * The hang is the worse failure, and not only because it is silent. `RedisSessionBackend.arm()` re-arms
 * by clearing its memo when `connect()` REJECTS; a promise that never settles disables that retry and
 * leaves every caller awaiting forever. So adding the listener without this would have traded a crash
 * that restarts for a wedge that does not.
 *
 * Bounded retry keeps both properties: a transient blip (a container recreated, or `docker run -d`
 * returning before Redis accepts) reconnects on its own, while a Redis that is genuinely absent gives
 * up and rejects, so the caller fails loudly and soon.
 *
 * ONE CONSEQUENCE EVERY CALLER MUST HANDLE. Past this bound node-redis gives up permanently, and it is
 * quiet about it on the post-open path: `#shouldReconnect` sets `#isOpen = false` before returning the
 * `ReconnectStrategyError` (socket.js:153-162), and `#onSocketError` swallows that error -- it calls
 * `#connect()` with a `.catch` whose body is the comment "the error was already emitted, silently
 * ignore it" (socket.js:333-335). Every later command then rejects `ClientClosedError`
 * (index.js:1127), for the life of the process. A memo that re-arms only on a REJECTED connect cannot
 * see this: the connect succeeded, so its promise stays resolved.
 *
 * So a client built with these options must also re-arm on `!client.isOpen`. `isOpen` is the precise
 * signal and nothing else: node-redis keeps it TRUE for the whole retry sequence (only `isReady` drops
 * while reconnecting) and false only on the terminal give-up or an explicit close. `RedisSessionBackend`,
 * `RedisWorkQueue` and `RedisResultStore` each do this in `open()`. `sharedLease` / `sharedRecords`
 * (select-sandbox.ts) are exempt, and their exemption is unconditional rather than caller-dependent:
 * `guard()` evicts the memo on any rejected command, and the wrapper resolves that memo PER COMMAND,
 * so the `ClientClosedError` itself rebuilds the client even for a caller holding a closure rather
 * than re-entering `sharedLease()`. Re-arming in place would be WRONG for those two, not merely
 * redundant: `dropMemo` closes the store it evicts, and `connect()` reopens a closed client, so an
 * in-place re-arm would resurrect a store no memo references and nothing will ever close again.
 *
 * `RedisRecordStore` (harness/src/pool-records.ts) reached the same pairing from the same probe in
 * #251 and keeps its own copy inline; this is the shared form for the other four long-lived clients.
 *
 * `maxReconnectAttempts` is a seam for tests, not a knob anyone is expected to set — it lets a test pin
 * "rejects rather than hangs" in milliseconds instead of waiting out the real backoff.
 */
export function resilientClientOptions(
  url: string,
  maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
): ResilientClientOptions {
  return {
    url,
    socket: {
      reconnectStrategy: (retries: number) =>
        retries > maxReconnectAttempts
          ? new Error(`redis at ${redactUrl(url)} unreachable after ${retries} attempts`)
          : Math.min(retries * 100, 1000),
    },
  };
}

/**
 * Register the `'error'` listener every long-lived node-redis client needs, so losing a socket costs a
 * reconnect rather than the process. Pair it with `resilientClientOptions` — see the note there for
 * why neither half stands alone.
 *
 * node-redis clients are EventEmitters and `RedisSocket.#onSocketError` re-emits every socket error on
 * the client, so with no listener Node treats it as an uncaught exception. It is specifically the
 * ESTABLISHED-connection path that crashes: a failed initial `connect()` emits too, but from inside the
 * awaited `connect()` chain, so that throw becomes the promise's rejection — which is exactly why
 * silencing it needs the reconnect bound to keep the rejection.
 *
 * Probed with `CLIENT KILL` on the probe's own connection: no listener exits on an uncaught
 * `SocketClosedUnexpectedlyError`; with one, the error is handled and node-redis reconnects on its own
 * (`isOpen` stays true). So the listener ENABLES the built-in recovery rather than hiding the error.
 *
 * Every store using this is memoised for the process's life, which raises the stakes: no turn need be
 * in flight for a drop to matter, so an idle-time Redis restart is enough.
 *
 * Log-and-swallow is the whole job. This suppresses nothing a caller awaits — a failed command still
 * rejects through its own promise — and the log is what tells an operator the reconnect happened.
 */
export function swallowRedisErrors(client: ErrorEmitter, label: string): void {
  client.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[redis] ${label}: ${message} (node-redis will reconnect)`);
  });
}
