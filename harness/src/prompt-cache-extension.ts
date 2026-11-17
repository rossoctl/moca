import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/**
 * Two opt-in caching switches (#754), for example for benchmarking and performance analysis, read
 * from the environment:
 *
 * - `SH_PROMPT_CACHE=off` strips Anthropic prompt-caching `cache_control` markers from the agent's
 *   model requests, so no prefix is written to or read from the provider's prompt cache;
 * - `SH_GATEWAY_CACHE=off` adds `cache: {"no-cache": true}` to those requests' bodies, so a caching
 *   gateway in front of the model does not answer from its own response cache.
 *
 * Why such a run needs them: when the same prompts are re-run to compare two configurations,
 * cached prefixes move tokens into the cache-read class and change the timings from one run to
 * the next, and a gateway's response cache can return a stored reply (same message id, no model
 * call) for a request byte-identical to an earlier one, so repeated reps stop being independent
 * samples. Neither is reachable today: pi-ai's providers always mark the system prompt, the last
 * tool and the last user message, and nothing on the harness's path sets `cacheRetention: "none"`
 * (`PI_CACHE_RETENTION` only knows "long").
 *
 * What they reach: every request pi's agent loop sends, because that loop is what runs the
 * `before_provider_request` hook. A compaction's summary request is sent by pi outside the loop,
 * without the hook, so it keeps its markers and carries no `no-cache`.
 *
 * These are deployment-wide operator switches, not per-session or per-tenant settings: they are
 * read from the worker's environment, so under `MOCA_TENANCY=multi` they apply to every tenant's
 * turns alike. Nothing a client sends can set or clear them.
 *
 * Accepted values are `off`, `on` and unset (or blank), which is today's behavior. Anything else
 * throws, naming the switch: a run that set `SH_PROMPT_CACHE=OFF` or `=false` and silently kept
 * caching would compare the wrong thing, which is the failure these switches exist to rule out.
 * The worker calls this at boot (packages/server/src/worker.ts), so a bad value fails the bring-up
 * rather than every turn; `promptCacheExtension` calls it again per stack, so a path that does not
 * boot through the worker (the CLI) fails its turn instead of running cached.
 */

/** The two switches as read; both false is today's behavior. */
export interface CacheSwitches {
  /** SH_PROMPT_CACHE=off: strip `cache_control` markers. */
  promptOff: boolean;
  /** SH_GATEWAY_CACHE=off: send `cache: {"no-cache": true}`. */
  gatewayOff: boolean;
}

function readSwitch(env: NodeJS.ProcessEnv, name: 'SH_PROMPT_CACHE' | 'SH_GATEWAY_CACHE'): boolean {
  const v = env[name];
  if (v === undefined || v === '' || v === 'on') return false;
  if (v === 'off') return true;
  // Exact and lower-case, like the other enum switches: `OFF` or ` off` is a typo to refuse, not
  // a spelling to forgive. The value is not a secret, so echoing it makes the typo visible.
  throw new Error(`${name} must be "off", "on" or unset; got ${JSON.stringify(v)}`);
}

/** Read both switches; throws on a value other than `off`, `on`, blank or unset. */
export function readCacheSwitches(env: NodeJS.ProcessEnv = process.env): CacheSwitches {
  return {
    promptOff: readSwitch(env, 'SH_PROMPT_CACHE'),
    gatewayOff: readSwitch(env, 'SH_GATEWAY_CACHE'),
  };
}

/**
 * The harness-internal extension that applies the two switches to the agent's model requests.
 *
 * It is passed to DefaultResourceLoader as an extension FACTORY, like toolChoiceExtension, which
 * is why it still applies in server mode: MI1 §5 R4's `noExtensions` turns off discovered
 * extension files only, never `extensionFactories`. It is not a file pi could discover or a user
 * could load or drop. It hooks `before_provider_request`, the payload seam toolChoiceExtension
 * already uses, and edits the provider payload in place.
 *
 * With both switches unset it registers no handler at all, and pi installs its payload hook only
 * when some extension has one -- so the request a turn sends is byte-for-byte what it was before.
 * The environment is read when the factory is BUILT (once per turn's stack), not when pi runs it:
 * pi catches and records a factory's throw as a load error, which would turn a refused value into
 * a quietly cached turn.
 */
export function promptCacheExtension(env: NodeJS.ProcessEnv = process.env): ExtensionFactory {
  const { promptOff, gatewayOff } = readCacheSwitches(env);
  return (pi) => {
    if (!promptOff && !gatewayOff) return;
    let logged = false;
    // Handler receives the event { type, payload }; returning a value replaces the payload
    // (runner.ts before_provider_request contract). Mutate + return event.payload.
    pi.on('before_provider_request', (event: { payload?: unknown }) => {
      const params = event.payload as Record<string, unknown> | undefined;
      if (!params || typeof params !== 'object') return undefined;
      const stripped = promptOff ? stripCacheControl(params) : 0;
      if (gatewayOff) bypassGatewayCache(params);
      if (!logged) {
        logged = true;
        // stderr so it always reaches container logs regardless of log level.
        if (promptOff)
          console.error(
            `[prompt-cache] off: removed ${stripped} cache_control marker(s) from the first request`,
          );
        if (gatewayOff)
          console.error('[gateway-cache] off: every request carries cache.no-cache = true');
      }
      return params;
    });
  };
}

/**
 * Ask a caching gateway not to answer from its RESPONSE cache (SH_GATEWAY_CACHE=off).
 *
 * The per-request control such a gateway reads is a body field, `cache: {"no-cache": true}`: it
 * skips the cache lookup, so the request goes to the model. Request metadata or a
 * `Cache-Control` header does not change the gateway's cache key, which is why this is a body
 * field. It is separate from prompt caching (SH_PROMPT_CACHE): the two are set independently. An
 * existing `cache` object keeps its other keys and only gains `no-cache`; a non-object value is
 * replaced. A provider's own API, reached without such a gateway, may reject the unknown field,
 * so this is for deployments whose model endpoint is a gateway that reads it.
 */
export function bypassGatewayCache(params: Record<string, unknown>): void {
  const cur = params.cache;
  params.cache = {
    ...(cur && typeof cur === 'object' && !Array.isArray(cur)
      ? (cur as Record<string, unknown>)
      : {}),
    'no-cache': true,
  };
}

/**
 * Delete every request-level `cache_control` marker in place (SH_PROMPT_CACHE=off); returns how
 * many were removed.
 *
 * pi-ai's Anthropic provider marks the system blocks, the last tool and the last block of the
 * final user message (a tool_result's own content too), and its OpenAI-compatible provider marks
 * the last tool and a text part of a message when its compat flags ask for Anthropic-style
 * caching. This removes the marker from the system blocks, the tools, and the content blocks of
 * every message, one level into a tool_result's own content. It touches only those keys: a tool's
 * input_schema is never walked, so a schema property that happens to be called `cache_control`
 * survives.
 */
export function stripCacheControl(params: Record<string, unknown>): number {
  let n = 0;
  const strip = (block: unknown) => {
    if (block && typeof block === 'object' && 'cache_control' in block) {
      delete (block as Record<string, unknown>).cache_control;
      n += 1;
    }
  };
  const blocks = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  blocks(params.system).forEach(strip);
  blocks(params.tools).forEach(strip);
  for (const msg of blocks(params.messages)) {
    if (!msg || typeof msg !== 'object') continue;
    for (const block of blocks((msg as { content?: unknown }).content)) {
      strip(block);
      // A tool_result carries its own content blocks, which the provider may also mark.
      if (block && typeof block === 'object')
        blocks((block as { content?: unknown }).content).forEach(strip);
    }
  }
  return n;
}
