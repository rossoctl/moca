import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { forLog } from './audit-log.js';
import { CpError, writeError } from './errors.js';
import { redeemInferenceGrant } from './grant-redeem.js';
import type { CpDeps } from './handlers.js';

/**
 * The INFERENCE LISTENER (MI1 §6.3, §8.6): where a worker spends its inference grant. Under
 * `MOCA_TENANCY=multi` it is the only thing between a worker and a provider -- the worker holds a
 * capability and never a key, and never chooses an upstream either: it sends every request to the
 * one `inferenceUrl` the dequeue exchange handed it, and THIS decides where that goes.
 *
 * It runs in the control-plane PROCESS on its own port, rather than in `moca-egress` as §8.6 has it
 * (decision D1, recorded in MI1 §14). Its own `createServer` rather than a route on the API router,
 * for two reasons that are not negotiable: the router buffers whole bodies (`readBody`), which an
 * SSE completion cannot tolerate, and its `authorize` switch knows four auth kinds, none of which is
 * "a grant". Staying out of `ROUTES` also keeps it out of the authz enumeration and OpenAPI drift
 * tests, which is right -- it is a transparent pass-through of someone else's API, not a moca route.
 *
 * PASS-THROUGH, not a client: method, path, query and body go upstream unchanged, so whatever pi
 * computes from `baseUrl` arrives at the provider exactly as it would have in direct mode. The one
 * rewrite is the credential header.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Not hop-by-hop, dropped anyway: `host` must name the upstream (fetch sets it), `content-length`
  // is wrong once the body is a stream, and the two credential headers are THIS function's to set --
  // forwarding the inbound ones would hand the provider the grant.
  'host',
  'content-length',
  'authorization',
  'x-api-key',
]);

export function buildInferenceHandler(
  deps: CpDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    forward(req, res, deps).catch((err: unknown) => {
      if (!(err instanceof CpError)) console.error('[inference] unhandled', err);
      // Headers already sent means the upstream answer was already streaming: there is no status
      // left to change, and writeError would throw. Drop the socket, so the client sees a truncated
      // stream rather than a successful short one.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      writeError(res, err);
    });
  };
}

async function forward(req: IncomingMessage, res: ServerResponse, deps: CpDeps): Promise<void> {
  const auth = req.headers.authorization ?? '';
  // One code for every way the bearer can be wrong, absent included: the data plane's only move on
  // any of them is to re-exchange (errors.ts explains the single code at length).
  const grant = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!grant) {
    throw new CpError('grant_invalid', 'present the turn inference grant as a Bearer token');
  }

  const path = req.url ?? '/';
  // The target is the credential endpoint CONCATENATED with the incoming path, so an endpoint
  // carrying a prefix (`https://gw/anthropic`) keeps it -- `new URL(path, endpoint)` would discard
  // the prefix and aim the secret at the gateway's root. That makes a `..` a way to climb out of the
  // prefix, so refuse one; no legitimate client sends it.
  if (!path.startsWith('/') || path.includes('..')) {
    throw new CpError('invalid_request', 'the inference path must be absolute and contain no ..');
  }

  const cred = await redeemInferenceGrant(grant, deps);
  const target = `${cred.baseUrl.replace(/\/+$/, '')}${path}`;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  // The header the credential's BINDING names (#368). This is why the worker's own header is
  // uniformly a Bearer grant: the shape a provider wants is decided here, where the credential is
  // known, and never by the worker. The one place the secret appears.
  headers[cred.authHeader] =
    cred.authHeader === 'authorization' ? `Bearer ${cred.secretValue}` : cred.secretValue;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      redirect: 'manual',
    } as RequestInit);
  } catch (err) {
    // The HOST, the credential NAME and the cause -- never the secret, and never the whole URL,
    // which can carry a query. 503 `credential_unavailable` rather than a new code: from the
    // caller's side this credential cannot be used right now, which is what that code means.
    let host = 'unparseable';
    try {
      host = new URL(target).host;
    } catch {
      /* the message is diagnostic; an unparseable endpoint is already the failure */
    }
    console.error(
      `[inference] upstream ${host} unreachable for credential '${forLog(cred.credentialName)}' ` +
        `(session ${forLog(cred.sessionId)}): ${(err as Error)?.message ?? String(err)}`,
    );
    throw new CpError('credential_unavailable', 'the inference endpoint is unreachable');
  }

  const out: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    // `content-encoding` is dropped on the way BACK only, which is why it is not in HOP_BY_HOP:
    // `fetch` advertises `accept-encoding: gzip, deflate` of its own accord and DECODES the body it
    // gets, while leaving the header the provider sent in place. Forwarding that header with an
    // already-decoded body makes the worker gunzip plain text, so every compressed answer -- which
    // is every non-streamed one from a provider that honours gzip -- fails. `content-length` is in
    // HOP_BY_HOP for the same reason: the decoded length is not the one upstream counted.
    if (!HOP_BY_HOP.has(k) && k !== 'content-encoding') out[k] = v;
  });
  res.writeHead(upstream.status, out);
  if (!upstream.body) {
    res.end();
    return;
  }
  // Streamed, not buffered: a completion is SSE, and a buffering proxy would hold the whole answer
  // and break every token-by-token consumer.
  await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream), res);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * Say so, once, when the listener is reachable from off the host.
 *
 * This is a CREDENTIAL BOUNDARY whose only caller check is the grant it redeems: there is no source
 * allowlist, so the bind address IS the access control (MI1 §8.6). Loopback enforces itself, and
 * anything else -- a pod IP, a wildcard -- trusts the network to carry only this deployment's own
 * workers. That is a real deployment decision, and an operator should meet it in the log they are
 * already reading at boot rather than only in the configuration reference.
 */
export function warnIfExposed(host?: string): void {
  if (host && LOOPBACK.has(host)) return;
  console.warn(
    `[inference] listening on ${host ?? '0.0.0.0'}, which is not loopback: this listener redeems ` +
      'grants for real provider credentials and authenticates nothing else, so the network it is ' +
      "on must reach only this deployment's own workers (MI1 §8.6)",
  );
}

/**
 * Bind the listener. Loopback on deploy/vm, where the worker shares the host; a pod or container IP
 * under compose and Kubernetes, where `MOCA_INFERENCE_URL` names the service.
 *
 * Shutting it down is the CALLER's job (see main.ts): a SIGTERM handler registered here would
 * accumulate one listener per server, and the tests start dozens.
 */
export function startInferenceProxy(deps: CpDeps, port: number, host?: string): Server {
  const server = createServer(buildInferenceHandler(deps));
  // Node's 300 s default requestTimeout would kill a long completion mid-stream, and a completion
  // legitimately runs for minutes. `turn_exp` (at most MOCA_TURN_MAX_S) and the worker's own turn
  // deadline are what bound it instead.
  // shortcut: no per-request upstream timeout at all, so a wedged provider holds a socket until the
  // worker gives up. Add one (AbortSignal.timeout on the fetch) when this listener faces callers
  // that are not this deployment's own workers.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  warnIfExposed(host);
  // `listen` takes an ADDRESS, not a URL authority: given `[::1]` it resolves the brackets as a
  // hostname and dies ENOTFOUND. `MOCA_INFERENCE_ADDR` is written the way a URL is, so strip them
  // here -- `inferenceUrlFromEnv` keeps them, because the URL side needs them.
  server.listen(port, host?.replace(/^\[(.*)]$/, '$1'));
  return server;
}
