import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { CpError, writeError } from './errors.js';
import type { EgressHost } from './egress-config.js';
import { checkExchangeAuth, checkStaticBearer } from './exchange.js';
import { HANDLERS, apiIssuer, type CpDeps, type RequestCtx } from './handlers.js';
import { membershipNow } from './handler-util.js';
import { matchRoute, type RouteSpec, bodyLimitFor } from './routes.js';
import { verifyToken } from './token.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Stop buffering rather than keep accumulating: an unbounded read is a trivial memory
      // exhaustion on a service that is by design always on. We still drain (rather than
      // `req.destroy()`) so the socket survives long enough to carry the error response back --
      // destroying the request mid-stream races the still-unread bytes sitting in the kernel's
      // receive buffer and the OS answers with an abortive RST (ECONNRESET) instead of delivering
      // the 400 the caller is waiting to read.
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new CpError('invalid_request', 'request body too large'));
        return;
      }
      resolve(Buffer.concat(chunks).toString());
    });
    req.on('error', reject);
  });
}

const bearer = (req: IncomingMessage): string | undefined => {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : undefined;
};

/** `::ffff:192.0.2.1` and `192.0.2.1` are one client: a dual-stack socket reports the former. */
const unmapped = (addr: string): string =>
  addr.toLowerCase().startsWith('::ffff:') && isIP(addr.slice(7)) === 4 ? addr.slice(7) : addr;

/**
 * The client's address, for bounds on unauthenticated work (RequestCtx.source). With no trusted
 * proxy it is the socket peer. Behind `hops` reverse proxies that each APPEND the address they saw
 * to X-Forwarded-For (an OpenShift Route's default), the last `hops` entries were written by those
 * proxies and everything left of them by the client, so the entry `hops` from the right is the
 * one the outermost trusted proxy saw -- the express `trust proxy = <count>` rule. Fewer entries
 * than hops means the request skipped a proxy, and the leftmost entry stands.
 *
 * The count is a deployment setting because a caller that reaches the control plane AROUND the
 * proxies writes the trusted entry itself: it can then pick its own bucket, or fill another
 * address's, for the state TTL (the total cap still holds). Through the proxies it cannot, since
 * they append after whatever it wrote. An entry that is not an IP address falls back to the socket
 * peer, which also keeps a header-sized string from becoming a map key.
 */
export function clientSource(req: IncomingMessage, hops: number): string | undefined {
  const peer = req.socket.remoteAddress;
  const fallback = peer === undefined ? undefined : unmapped(peer);
  if (hops <= 0) return fallback;
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (!header) return fallback;
  const entries = header.split(',').map((e) => e.trim());
  const picked = entries[Math.max(0, entries.length - hops)]!;
  return isIP(picked) !== 0 ? unmapped(picked) : fallback;
}

/**
 * Authenticate per the ROUTE's declared kind, not per handler. The router is the only layer that sees
 * headers, so it is the only place this can live -- and driving it off RouteSpec.auth is what makes
 * "which routes need a token" enumerable by a test rather than scattered through handler bodies.
 */
function authorize(route: RouteSpec, req: IncomingMessage, deps: CpDeps, ctx: RequestCtx): void {
  if (route.auth === 'none') return;
  const presented = bearer(req);
  if (route.auth === 'exchange') {
    // Throws CpError('unauthorized') with no mention of the presented value (spec §5.3.1).
    checkExchangeAuth(presented, deps.config.exchangeToken);
    ctx.exchangeAuthorized = true;
    return;
  }
  if (route.auth === 'janitor') {
    // The host janitor's SH_JANITOR_TOKEN, and nothing else: a user's or an admin's API token is
    // refused here, and with none configured every call is (SBX0 §8.3).
    checkStaticBearer(presented, deps.config.sandbox?.janitorToken, 'janitor');
    ctx.janitorAuthorized = true;
    return;
  }
  if (route.auth === 'egress') {
    // Compare against EVERY configured host and never return early, so timing shows nothing about
    // which host matched. Digests keep the comparison fixed-length (as checkStaticBearer does).
    // With no hosts, no bearer or no match: 401, naming neither the host list nor the value.
    const want = presented ? createHash('sha256').update(presented).digest() : undefined;
    let found: EgressHost | undefined;
    for (const h of deps.config.sandbox?.egress?.hosts ?? []) {
      const have = createHash('sha256').update(h.token).digest();
      if (want && timingSafeEqual(want, have) && found === undefined) found = h;
    }
    if (!found) throw new CpError('unauthorized', 'egress authentication failed');
    ctx.egressHost = found;
    return;
  }
  if (route.auth === 'host') {
    // As for egress: every configured host compared, no early return, digests of fixed length. The
    // host named in the path must be the one whose token was presented (a host acts only as itself).
    const want = presented ? createHash('sha256').update(presented).digest() : undefined;
    let found: string | undefined;
    for (const h of deps.config.templateHosts ?? []) {
      const have = createHash('sha256').update(h.token).digest();
      if (want && timingSafeEqual(want, have) && found === undefined) found = h.id;
    }
    if (!found || found !== ctx.params.host)
      throw new CpError('unauthorized', 'host authentication failed');
    ctx.host = found;
    return;
  }
  if (!presented) throw new CpError('token_required', 'this route requires a token');
  // requiredScope 'api' is what stops a session token rewriting credentials or creating a second
  // session, and stops the shared exchange bearer standing in for a user identity (plan gap #7).
  ctx.principal = verifyToken(presented, deps.verifyKeys, {
    now: Math.floor(deps.now() / 1000),
    requiredScope: 'api',
    issuer: apiIssuer(deps.config),
  });
}

/** A handler's streamed body: chunks written as they come, so a large answer is never held whole. */
const isStream = (b: unknown): b is AsyncIterable<string> =>
  typeof b === 'object' && b !== null && Symbol.asyncIterator in b;

/**
 * Writes a streamed body with backpressure (the egress log's NDJSON export). The first chunk is read
 * before the status goes out, so a store that fails at once still answers its error (a 503); one that
 * fails mid-stream can only cut the response short, which the client sees as a truncated body.
 */
async function writeStream(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: AsyncIterable<string>,
): Promise<void> {
  const it = body[Symbol.asyncIterator]();
  let next = await it.next();
  res.writeHead(status, headers);
  try {
    while (!next.done) {
      // A client that goes away mid-stream closes the response: stop reading the store.
      if (!res.write(next.value)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
      if (res.destroyed) {
        await it.return?.();
        return;
      }
      next = await it.next();
    }
    res.end();
  } catch (err) {
    console.error('[control-plane] streamed response cut short:', (err as Error)?.message);
    await it.return?.();
    res.destroy();
  }
}

export function buildHandler(deps: CpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const route = async () => {
      const matched = matchRoute(
        req.method ?? '',
        req.url ?? '',
        deps.config.routeProfile ?? 'harness',
        // Every gate, in one object. ADR-0045: a feature-gated route is unmounted when its
        // feature is off, so it 404s before the body below is read -- otherwise an empty body
        // would answer 400 invalid_json and thereby reveal that the route exists.
        {
          egress: deps.config.sandbox?.egress !== undefined,
          testUsers: !!deps.testUsers,
          grants: deps.grantSigner !== undefined,
        },
      );
      if (!matched) {
        res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const source = clientSource(req, deps.config.trustedProxyHops ?? 0);
      const ctx: RequestCtx = {
        params: matched.params,
        query: url.searchParams,
        body: undefined,
        ...(source !== undefined ? { source } : {}),
      };

      // AUTHENTICATION FIRST, then the body. `authorize` reads only headers, so the order is free --
      // and with it reversed an unauthenticated `PUT /v1/credentials/x` carrying malformed JSON got
      // 400 invalid_json instead of 401, telling an anonymous caller something about the route's body
      // handling before it had established the caller may talk to the route at all. Nothing of
      // consequence leaked and the 64 KiB cap bounded it, but authentication belongs in front. Every
      // route here is new in MU1, so no existing caller depends on the old codes.
      authorize(matched.route, req, deps, ctx);
      // Roles and enrollment NOW: a token's `roles` are what was true at its mint; with
      // a members store the subject's current ones replace them, so a grant, revoke or lapse takes
      // effect at the next request. Without a store the token's claims stand, as before.
      if (ctx.principal && deps.members) {
        const m = await membershipNow(deps, ctx.principal.sub, ctx.principal.roles ?? []);
        ctx.principal = { ...ctx.principal, roles: m.roles, enrolled: m.enrolled };
      } else if (ctx.principal) {
        // A token never carries enrollment: only this step sets it.
        const { enrolled: _ignored, ...claims } = ctx.principal;
        ctx.principal = claims;
      }

      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const raw = await readBody(req, bodyLimitFor(matched.route));
        if (raw.length > 0) {
          // Two body languages: JSON for every client, and urlencoded for the one HTML form a
          // browser submits (the oidc confirmation, and only where the route opted in with
          // formBody -- a JSON route that also parsed forms would be reachable by a plain
          // cross-origin <form>, a CORS "simple" request, for no gain).
          if (
            matched.route.formBody === true &&
            (req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')
          ) {
            ctx.body = Object.fromEntries(new URLSearchParams(raw));
          } else {
            try {
              ctx.body = JSON.parse(raw);
            } catch {
              throw new CpError('invalid_json', 'body is not valid JSON');
            }
          }
        } else if (matched.route.bodyRequired !== false) {
          // A route whose handler never reads ctx.body (startDeviceAuth, mintSessionToken) sets
          // bodyRequired: false; every other POST/PUT/PATCH needs one, and an empty body must be a 400
          // rather than an `undefined` a handler then misreads as `{}`.
          throw new CpError('invalid_json', 'body is required');
        }
      }

      const handler = HANDLERS[matched.route.operationId];
      // A declared-but-unwired route is a programming error; the enumeration test catches it in CI,
      // and this is the runtime answer if one ever slips through.
      if (!handler) throw new CpError('internal_error', 'route has no handler');

      const { status, body, contentType, headers } = await handler(ctx, deps);
      // A handler's extra response headers (the oidc page's no-store / frame denial); none by
      // default, so nothing else on the wire changes.
      const extra = headers ?? {};
      if (body === undefined) {
        res.writeHead(status, extra).end();
        return;
      }
      if (isStream(body)) {
        await writeStream(
          res,
          status,
          { 'Content-Type': contentType ?? 'text/plain', ...extra },
          body,
        );
        return;
      }
      if (Buffer.isBuffer(body)) {
        // Bytes, written as-is. Without this the fall-through below would JSON-encode the buffer
        // and a patch would go out as `{"type":"Buffer","data":[...]}` (#390).
        res
          .writeHead(status, {
            'Content-Type': contentType ?? 'application/octet-stream',
            'Content-Length': String(body.byteLength),
            ...extra,
          })
          .end(body);
        return;
      }
      if (typeof body === 'string') {
        // A string body is plain text unless the handler says otherwise -- only the oidc callback
        // page renders HTML, and it is the one route answered by a browser rather than a client.
        res.writeHead(status, { 'Content-Type': contentType ?? 'text/plain', ...extra }).end(body);
        return;
      }
      res.writeHead(status, { ...JSON_HEADERS, ...extra }).end(JSON.stringify(body));
    };

    route().catch((err) => {
      // Every error leaves through writeError, which maps a CpError to its status and reduces anything
      // else to a bare `internal_error` -- so a Redis URL with a password in it cannot reach a caller.
      if (!(err instanceof CpError)) console.error('[control-plane] unhandled', err);
      writeError(res, err);
    });
  };
}

export function startControlPlane(deps: CpDeps, port = 8080, host?: string): Server {
  const server = createServer(buildHandler(deps));
  // Stop accepting and let in-flight requests finish, THEN release Redis (#434): closing it first
  // would fail those requests with redis_unavailable on the way out. A close() that throws must not
  // keep the process alive past the SIGTERM.
  //
  // close() reaps the keep-alive connections idle when it is called, but not one whose request was
  // in flight and goes idle afterwards (#436): the ingress would hold that socket, and with it the
  // exit and the Redis release, for keepAliveTimeout. So while draining, each finished response
  // reaps whatever is idle by then.
  let draining = false;
  server.on('request', (_req, res) => {
    res.once('finish', () => {
      if (draining) setImmediate(() => server.closeIdleConnections());
    });
  });
  const onSigterm = () => {
    draining = true;
    server.close(() => {
      void Promise.resolve()
        .then(() => deps.close?.())
        .catch((err: unknown) =>
          console.error('[control-plane] close on SIGTERM failed:', (err as Error)?.message ?? err),
        )
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', onSigterm);
  // A production process calls this once; a test suite calls it once per test. Without removing the
  // listener on close, every server started this way leaks one 'SIGTERM' handler on `process` for the
  // life of the process, tripping Node's MaxListenersExceededWarning well before a real suite's tenth
  // test and masking a genuine future leak behind expected noise.
  server.once('close', () => process.removeListener('SIGTERM', onSigterm));
  const onListening = () => {
    // The socket's own address, never the configured string: `host` comes from the same env object
    // as the resolved secrets (main.ts withCredentials), and nothing read from it is logged.
    const addr = server.address();
    const bound =
      typeof addr === 'object' && addr ? `${host ? addr.address : ''}:${addr.port}` : `:${port}`;
    console.log(`sh-control-plane listening on ${bound}`);
  };
  // `listen(port, undefined, cb)` is not a documented overload; keep the two calls distinct.
  if (host) server.listen(port, host, onListening);
  else server.listen(port, onListening);
  return server;
}
