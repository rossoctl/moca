import { ApiError, TurnCancelledError } from './errors.js';
import type { TurnFrame } from './frames.js';
import { HarnessClient } from './harness.js';
import type {
  AttachArgs,
  CancelTurnArgs,
  CancelTurnResult,
  ControlPlaneApi,
  HarnessApi,
  StreamTurnArgs,
} from './types.js';
import { trimTrailingSlashes } from './url.js';

/** The fix a user needs when the control plane cannot say where the harness is. */
const OVERRIDE = 'or pass --harness-url';

/**
 * Asks the control plane where the harness is (GET /v1/discovery), so a user configures one URL.
 * A 404 is a control plane that predates discovery; `null` is one whose operator set no
 * SH_PUBLIC_HARNESS_URL. Both fail with a code the UI shows verbatim, naming its own fix.
 */
export async function discoverHarnessUrl(cp: ControlPlaneApi): Promise<string> {
  let advertised: unknown;
  try {
    advertised = (await cp.discovery()).harnessUrl;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new ApiError(
        'control-plane',
        404,
        'discovery_unsupported',
        `this control plane predates /v1/discovery and cannot say where the harness is — upgrade it, ${OVERRIDE}`,
      );
    }
    throw err;
  }
  if (advertised === null || advertised === undefined) {
    throw new ApiError(
      'control-plane',
      404,
      'harness_unadvertised',
      `the control plane advertises no harness URL — its operator must set SH_PUBLIC_HARNESS_URL, ${OVERRIDE}`,
    );
  }
  // The value is server-supplied: only an absolute http(s) URL is used, and only as the URL parser
  // serialises it (which percent-encodes control characters), since doctor prints it.
  const url = typeof advertised === 'string' ? parseHttpUrl(advertised) : undefined;
  if (!url) {
    throw new ApiError(
      'control-plane',
      404,
      'harness_unadvertised',
      `the control plane advertises a harness URL that is not an http(s) URL — its operator must fix SH_PUBLIC_HARNESS_URL, ${OVERRIDE}`,
    );
  }
  return trimTrailingSlashes(url.href);
}

function parseHttpUrl(s: string): URL | undefined {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A harness client that finds its own URL on first use. A success is kept for the life of the
 * client; a failure is not, so fixing the deployment needs no restart.
 */
export class DiscoveringHarness implements HarnessApi {
  private client?: Promise<HarnessClient>;

  constructor(
    private readonly discover: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private resolve(): Promise<HarnessClient> {
    if (!this.client) {
      const pending = this.discover().then((url) => new HarnessClient(url, this.fetchImpl));
      this.client = pending;
      pending.catch(() => {
        if (this.client === pending) this.client = undefined;
      });
    }
    return this.client;
  }

  async baseUrl(): Promise<string> {
    return (await this.resolve()).baseUrl();
  }

  async health(): Promise<void> {
    return (await this.resolve()).health();
  }

  async *streamTurn(args: StreamTurnArgs): AsyncGenerator<TurnFrame> {
    const client = await this.resolve();
    // A cancel that lands while discovery is still in flight is still a cancel.
    if (args.signal?.aborted) throw new TurnCancelledError();
    yield* client.streamTurn(args);
  }

  async probeTrust(token: string, sessionId: string): Promise<'trusted' | 'untrusted'> {
    return (await this.resolve()).probeTrust(token, sessionId);
  }

  async *attach(args: AttachArgs): AsyncGenerator<TurnFrame> {
    const client = await this.resolve();
    if (args.signal?.aborted) throw new TurnCancelledError();
    yield* client.attach(args);
  }

  async cancelTurn(args: CancelTurnArgs): Promise<CancelTurnResult> {
    return (await this.resolve()).cancelTurn(args);
  }
}
