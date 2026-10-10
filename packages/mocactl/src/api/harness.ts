import { ApiError, TurnCancelledError, errorFromResponse, networkError } from './errors.js';
import { isTerminal, type TurnFrame } from './frames.js';
import { readSse, toFrame } from './sse-parser.js';
import type {
  AttachArgs,
  CancelTurnArgs,
  CancelTurnResult,
  HarnessApi,
  StreamTurnArgs,
} from './types.js';
import { trimTrailingSlashes } from './url.js';

/**
 * A clean finish, as the harness's terminalFrame reads it (harness/src/turn-stream.ts): pi's
 * normalized reasons (`stop`, `length` -- what a real turn reports) and the Anthropic wire's
 * (`end_turn`, `max_tokens`). Checking only the wire's made every real clean reply read as an error.
 * A copy, not an import -- this client takes no workspace dependency, so it never pulls in pi -- held
 * equal to the harness's set by test/harness.test.ts.
 */
export const CLEAN_STOP_REASONS = new Set(['stop', 'length', 'end_turn', 'max_tokens']);

export class HarnessClient implements HarnessApi {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = trimTrailingSlashes(baseUrl);
  }

  async baseUrl(): Promise<string> {
    return this.base;
  }

  async health(): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/health`, { method: 'GET' });
    } catch (err) {
      throw networkError('harness', err);
    }
    if (!res.ok) throw await errorFromResponse('harness', res);
  }

  async *streamTurn({
    sessionId,
    prompt,
    token,
    signal,
    detachable,
    onEventId,
  }: StreamTurnArgs): AsyncGenerator<TurnFrame> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/v1/turn`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId, prompt, ...(detachable ? { detachable: true } : {}) }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new TurnCancelledError();
      throw networkError('harness', err);
    }
    if (!res.ok) throw await errorFromResponse('harness', res);

    // A harness (or proxy) that ignores Accept answers with the sync JSON body; render it rather
    // than fail.
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const r = (await res.json()) as {
        sessionId?: string;
        response?: string;
        stopReason?: string;
        errorMessage?: string;
      };
      if (r.response) yield { type: 'text', delta: r.response };
      const stopReason = r.stopReason ?? 'end_turn';
      yield r.errorMessage || !CLEAN_STOP_REASONS.has(stopReason)
        ? {
            type: 'error',
            sessionId: r.sessionId ?? sessionId,
            stopReason,
            errorMessage: r.errorMessage,
          }
        : { type: 'done', sessionId: r.sessionId ?? sessionId, stopReason };
      return;
    }
    yield* this.frames(res, signal, onEventId);
  }

  async *attach({
    sessionId,
    token,
    lastEventId,
    signal,
    onEventId,
  }: AttachArgs): AsyncGenerator<TurnFrame> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.base}/v1/turn?sessionId=${encodeURIComponent(sessionId)}`,
        {
          method: 'GET',
          headers: {
            accept: 'text/event-stream',
            authorization: `Bearer ${token}`,
            ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
          },
          signal,
        },
      );
    } catch (err) {
      if (signal?.aborted) throw new TurnCancelledError();
      throw networkError('harness', err);
    }
    // A harness without the route answers a bare 404, which means the same: nothing to attach to.
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      throw new ApiError('harness', 404, 'turn_not_found');
    }
    if (!res.ok) throw await errorFromResponse('harness', res);
    yield* this.frames(res, signal, onEventId);
  }

  async cancelTurn({
    sessionId,
    turnId,
    token,
    signal,
  }: CancelTurnArgs): Promise<CancelTurnResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/v1/turn/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId, ...(turnId ? { turnId } : {}) }),
        signal,
      });
    } catch (err) {
      throw networkError('harness', err);
    }
    // A harness without the route answers a bare 404: no turn to cancel there, as in `attach`.
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      throw new ApiError('harness', 404, 'turn_not_found');
    }
    if (!res.ok) throw await errorFromResponse('harness', res);
    // The 202 names the turn the server cancelled ('requested') or found already ended ('ended');
    // an older server omits the outcome, and a body without a turnId is still an accepted cancel.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const b = (body ?? {}) as { turnId?: unknown; outcome?: unknown };
    return {
      ...(typeof b.turnId === 'string' ? { turnId: b.turnId } : {}),
      ...(b.outcome === 'requested' || b.outcome === 'ended' ? { outcome: b.outcome } : {}),
    };
  }

  /**
   * Reads SSE frames to the first terminal one, or to an ended `turn` frame (an attach already
   * caught up on a finished turn); a stream that ends before either is truncated.
   */
  private async *frames(
    res: Response,
    signal: AbortSignal | undefined,
    onEventId: ((id: string) => void) | undefined,
  ): AsyncGenerator<TurnFrame> {
    if (!res.body)
      throw new ApiError('harness', 0, 'stream_truncated', 'the harness returned no stream');
    try {
      for await (const event of readSse(res.body)) {
        const frame = toFrame(event);
        if (event.id !== undefined) onEventId?.(event.id);
        yield frame;
        if (isTerminal(frame) || (frame.type === 'turn' && frame.ended)) return;
      }
    } catch (err) {
      if (signal?.aborted) throw new TurnCancelledError();
      throw networkError('harness', err);
    }
    if (signal?.aborted) throw new TurnCancelledError();
    throw new ApiError(
      'harness',
      0,
      'stream_truncated',
      'the harness closed the stream before the turn finished',
    );
  }

  /**
   * Whether this harness verifies this control plane's session tokens, without running a turn.
   * The body names a DIFFERENT session than the token: a harness that verifies the token refuses it
   * with session_mismatch before the credential exchange or any model call (turn-auth.ts). A harness
   * without the keyset answers token_invalid; one with no token handling at all falls through to
   * session_not_found or runs the turn.
   */
  async probeTrust(token: string, sessionId: string): Promise<'trusted' | 'untrusted'> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/v1/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId: `${sessionId}-mocactl-probe`,
          prompt: 'mocactl trust probe',
        }),
      });
    } catch (err) {
      throw networkError('harness', err);
    }
    if (res.status === 400) {
      const err = await errorFromResponse('harness', res);
      if (err.code === 'session_mismatch') return 'trusted';
      throw err;
    }
    if (res.status === 401 || res.status === 404 || res.ok) {
      await res.body?.cancel();
      return 'untrusted';
    }
    throw await errorFromResponse('harness', res);
  }
}
