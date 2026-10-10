import { ApiError, TOKEN_CODES, TurnCancelledError } from '../api/errors.js';
import { isTerminal, type TurnFrame } from '../api/frames.js';
import type {
  ControlPlaneApi,
  CreateSessionRequest,
  HarnessApi,
  SessionToken,
} from '../api/types.js';
import type { TranscriptStore } from './transcripts.js';

export class HarnessUntrustedError extends Error {
  constructor() {
    super(
      'the harness rejected a freshly minted session token — it is likely missing MU1 auth configuration. Run doctor for details: `/doctor` in the app, or `mocactl doctor`.',
    );
    this.name = 'HarnessUntrustedError';
  }
}

/**
 * How long a second Esc has to clear the queue: after a cancelled turn, the next queued prompt
 * waits this long before it is sent, so a double Esc never dispatches it first.
 */
export const DOUBLE_ESC_MS = 1000;

/** Re-attach after a dropped stream of a detachable turn (spec §6.5): tries and first backoff. */
export const REATTACH_TRIES = 5;
export const REATTACH_BASE_MS = 500;
export const LOST_TURN_MESSAGE =
  'lost the connection to the running turn — it may still be running; reopen the session to reattach';
/** How long a server-side cancel may take before it counts as failed; the request is then aborted. */
export const CANCEL_TIMEOUT_MS = 5000;
/**
 * Esc on a detachable turn whose first frame has not come yet: how long the cancel waits for the
 * `turn` frame (and its turnId) before it aborts the request and cancels the session's running
 * turn by session (no turnId).
 */
export const PENDING_CANCEL_MS = 2000;
/**
 * That turnId-less cancel can land before the server's `begin()`, which answers turn_not_found
 * (or a 202 naming the previous, ended turn): it is tried this many times in all, this far apart.
 * The spacing is 3 s from the first try to the last; each try may also take up to
 * CANCEL_TIMEOUT_MS. On a harness without the route every try answers 404 and the tries run out.
 */
export const BLIND_CANCEL_TRIES = 3;
export const BLIND_CANCEL_RETRY_MS = 1500;
const MAX_CONFLICTS = 3;
const CANCEL_FAILED_NOTICE = "couldn't cancel — the turn keeps running";

export type SessionEvent =
  | { kind: 'turn-start'; prompt: string }
  | { kind: 'attach-start' }
  | { kind: 'attach-none'; missed: boolean }
  | { kind: 'frame'; frame: TurnFrame }
  | { kind: 'notice'; text: string; tone: 'info' | 'warning' | 'error' }
  | { kind: 'retrying'; seconds: number }
  | { kind: 'turn-end'; outcome: 'done' | 'error' | 'cancelled'; error?: Error }
  | { kind: 'queue'; size: number };

export interface SessionDeps {
  cp: ControlPlaneApi;
  harness: HarnessApi;
  transcripts?: TranscriptStore;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  remintMarginS?: number;
  /** The pause after a cancelled turn before the queue drains on (default DOUBLE_ESC_MS; 0: none). */
  cancelPauseMs?: number;
  /** Ask for turns that outlive the connection (the TUI; not headless). */
  detachable?: boolean;
  /** The bound on a server-side cancel (default CANCEL_TIMEOUT_MS). */
  cancelTimeoutMs?: number;
  /** How long an Esc before the first frame waits for it (default PENDING_CANCEL_MS). */
  pendingCancelMs?: number;
}

type PromptJob = { kind: 'prompt'; prompt: string; resend: boolean; conflicts: number };
type Job =
  | PromptJob
  // `conflict`: a 409's attach to a turn another client started, and the prompt it holds back.
  | { kind: 'attach'; lastEventId?: string; expectOpen: boolean; conflict?: { resend: PromptJob } };

/**
 * How one stream ended: on a terminal frame (a cancel's own, or any other), without one, or
 * 'caught-up' -- an attach whose cursor was already at the finished turn's terminal.
 */
type StreamEnd = 'terminal' | 'cancelled' | 'ended' | 'caught-up';

/**
 * Where one job's streams stand: the last frame id seen, how many frames were consumed, and how
 * many of those were new output (not a `turn` frame, which every re-attach repeats first).
 */
type Cursor = { last?: string; frames: number; progress?: number };

const isTokenRejection = (err: unknown): err is ApiError =>
  err instanceof ApiError &&
  err.source === 'harness' &&
  (TOKEN_CODES.has(err.code) || err.code === 'session_mismatch');

const isDropped = (err: unknown): boolean =>
  err instanceof ApiError &&
  err.source === 'harness' &&
  (err.code === 'network_error' || err.code === 'stream_truncated');

/** A harness that cannot serve the re-attach right now (a worker drain, a gateway, Redis). */
const isUnavailable = (err: unknown): boolean =>
  err instanceof ApiError &&
  err.source === 'harness' &&
  (err.status === 502 ||
    err.status === 503 ||
    err.status === 504 ||
    err.code === 'redis_unavailable');

export class ActiveSession {
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private queue: Job[] = [];
  private controller?: AbortController;
  private running = false;
  private idleWaiters: Array<() => void> = [];
  private endPause?: () => void;
  /** The running turn, once its `turn` frame named it; only detachable turns have one. */
  private live?: { turnId: string; lastEventId?: string };
  private detaching = false;
  /** The server-side cancel in flight for one turn, shared by every cancel of it until it settles. */
  private cancelling?: { turnId: string; promise: Promise<boolean> };
  /**
   * A detachable turn's request is out and no frame has come: the server may already hold its lease
   * (it writes the `turn` frame lazily, with the first real one), so it counts as running.
   */
  private pending = false;
  /** An Esc while pending, waiting for the first frame (or PENDING_CANCEL_MS) to say what to do. */
  private deferred?: {
    promise: Promise<boolean>;
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  /** The running attach job is a 409's, following a turn this client did not start. */
  private conflict?: { resend: PromptJob };
  /** The last turn any `turn` frame named: a turnId-less cancel's 202 for it cancelled nothing new. */
  private lastTurnId?: string;
  /**
   * The turnId-less cancel after a pending Esc's deadline, until it settles. The queue waits for
   * it: a prompt sent meanwhile would start the very turn a late try could cancel.
   */
  private blindCancel?: Promise<boolean>;

  constructor(
    private readonly deps: SessionDeps,
    readonly sessionId: string,
    private token: SessionToken,
  ) {}

  on(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get busy(): boolean {
    return this.running;
  }

  /** Waiting prompts; a queued attach job is not one. */
  get queued(): number {
    return this.queue.filter((j) => j.kind === 'prompt').length;
  }

  get runningDetachable(): boolean {
    return this.running && (this.live !== undefined || this.pending);
  }

  // The server does not serialize concurrent turns of one session (spec §2.6); this queue does.
  // A resend (the replay after a re-login) runs a prompt the transcript already holds, so it is
  // not recorded again.
  submit(prompt: string, opts: { resend?: boolean } = {}): void {
    this.queue.push({ kind: 'prompt', prompt, resend: opts.resend === true, conflicts: 0 });
    this.emit({ kind: 'queue', size: this.queued });
    void this.drain().catch(() => undefined);
  }

  /** On resume (spec §6.5): ahead of any prompt, catch up on the session's last turn. */
  attachExisting(opts: { lastEventId?: string; expectOpen: boolean }): void {
    this.queue.unshift({ kind: 'attach', ...opts });
    void this.drain().catch(() => undefined);
  }

  /**
   * Esc: a detachable turn is cancelled on the server and read to its terminal (spec §6.4). A 409's
   * attach is not this client's turn: Esc stops following it and withdraws the held-back prompt.
   */
  cancel(): void {
    if (this.conflict) this.withdraw();
    else if (this.live || this.pending) void this.cancelRemote();
    else this.controller?.abort();
  }

  /**
   * Asks the server to cancel the running detachable turn; false (and a notice) if it could not.
   * A second call for the same turn while one is in flight (a double Esc) shares it rather than
   * sending another. Before the first frame the cancel waits for it (see `deferCancel`). A 409's
   * attach is never cancelled: it is withdrawn, as Esc does, and that resolves true.
   */
  cancelRemote(): Promise<boolean> {
    if (this.conflict) {
      this.withdraw();
      return Promise.resolve(true);
    }
    const live = this.live;
    if (!live) return this.pending ? this.deferCancel() : Promise.resolve(false);
    if (this.cancelling?.turnId === live.turnId) return this.cancelling.promise;
    const promise = this.sendCancel(live.turnId).finally(() => {
      if (this.cancelling?.promise === promise) this.cancelling = undefined;
    });
    this.cancelling = { turnId: live.turnId, promise };
    return promise;
  }

  /**
   * Esc before the first frame: keep reading. A `turn` frame names the turn to cancel on the server;
   * any other frame (a harness without detachable turns) means aborting the request, as Esc always
   * did. With no frame within PENDING_CANCEL_MS the request is aborted too, but the server may
   * already hold the turn (it writes the `turn` frame lazily), and closing a detachable request
   * detaches rather than cancels it: so the session's running turn is also cancelled on the server
   * by session (see `cancelBySession`). Resolves as the cancel does.
   */
  private deferCancel(): Promise<boolean> {
    if (this.deferred) return this.deferred.promise;
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => (resolve = r));
    const timer = setTimeout(() => {
      if (this.deferred?.promise !== promise) return;
      this.deferred = undefined;
      this.controller?.abort();
      const blind = this.cancelBySession().finally(() => {
        if (this.blindCancel === blind) this.blindCancel = undefined;
      });
      this.blindCancel = blind;
      void blind.then(resolve);
    }, this.deps.pendingCancelMs ?? PENDING_CANCEL_MS);
    this.deferred = { promise, resolve, timer };
    return promise;
  }

  private takeDeferred(): { resolve: (ok: boolean) => void } | undefined {
    const d = this.deferred;
    if (d) clearTimeout(d.timer);
    this.deferred = undefined;
    return d;
  }

  /** Esc on a 409's attach: stop following the other client's turn; its prompt is not sent. */
  private withdraw(): void {
    const c = this.conflict;
    if (!c) return;
    this.queue = this.queue.filter((j) => j !== c.resend);
    this.emit({ kind: 'queue', size: this.queued });
    this.detach();
  }

  private async sendCancel(turnId: string): Promise<boolean> {
    try {
      await this.cancelOnce(turnId);
      return true;
    } catch {
      this.emit({ kind: 'notice', text: CANCEL_FAILED_NOTICE, tone: 'error' });
      return false;
    }
  }

  /**
   * Cancels whatever turn the session runs, before this client learned its turnId. True once the
   * server accepted it (202), or when every try found no turn; false (and a notice) on any other
   * failure. turn_not_found is retried: the cancel can land before `begin()`. Each try is bounded
   * by cancelTimeoutMs, so this can take up to about 18 s in the worst case (3 tries of up to 5 s,
   * plus 3 s of spacing), and the queue waits that long.
   * Accepted risk: if this request never reached `begin()` and another device started a turn in
   * that window, that is the turn cancelled.
   */
  private async cancelBySession(): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        const named = await this.cancelOnce(undefined);
        // A 202 naming the session's previous, already-ended turn (the cancel landed before
        // begin()) cancelled nothing of this turn: it reads as finding no turn.
        if (named === undefined || named !== this.lastTurnId) return true;
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'turn_not_found')) {
          this.emit({ kind: 'notice', text: CANCEL_FAILED_NOTICE, tone: 'error' });
          return false;
        }
      }
      // No turn holds the session, on every try: on Knative or an older harness the abort stopped
      // it, and on P6 the request was aborted before begin(). Nothing is left to cancel.
      if (attempt >= BLIND_CANCEL_TRIES) return true;
      await this.deps.sleep(BLIND_CANCEL_RETRY_MS);
    }
  }

  /**
   * One server-side cancel, bounded by cancelTimeoutMs; throws when it was not accepted. Resolves
   * with the turnId the 202 named, if any.
   */
  private async cancelOnce(turnId: string | undefined): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort(); // a cancel given up on must not linger as an open request
        reject(new Error('cancel timed out'));
      }, this.deps.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS);
    });
    const call = async () => {
      await this.ensureToken();
      const r = await this.deps.harness.cancelTurn({
        sessionId: this.sessionId,
        ...(turnId !== undefined ? { turnId } : {}),
        token: this.token.token,
        signal: abort.signal,
      });
      return r ? r.turnId : undefined;
    };
    try {
      return await Promise.race([call(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Quit or switch with "keep it running" (spec §6.3): stop reading; the server turn goes on.
   * Callers should `clearQueue()` first: a prompt still queued is sent at once, meets the turn
   * just detached from (`409 turn_in_progress`), and attaches straight back to it.
   */
  detach(): void {
    if (!this.controller) return;
    this.detaching = true;
    this.controller.abort();
  }

  clearQueue(): void {
    this.queue = this.queue.filter((j) => j.kind !== 'prompt');
    this.emit({ kind: 'queue', size: 0 });
    this.endPause?.(); // nothing is left to wait for
  }

  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private emit(e: SessionEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // Ignore listener errors; they should not break the session
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        // A turnId-less cancel still trying would cancel the next job's turn: let it settle first.
        if (this.blindCancel) {
          await this.blindCancel;
          continue; // the queue may have changed meanwhile (a clearQueue)
        }
        const job = this.queue.shift()!;
        this.emit({ kind: 'queue', size: this.queued });
        const cancelled =
          job.kind === 'prompt' ? await this.runTurn(job) : await this.runAttach(job);
        // A detach is not an Esc: no second Esc is coming, so the queue need not wait for one.
        const detached = this.detaching;
        this.detaching = false;
        if (cancelled && !detached && this.queue.length > 0 && this.deps.cancelPauseMs !== 0)
          await this.pause();
      }
    } finally {
      this.running = false;
      this.detaching = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const end = () => {
        clearTimeout(timer);
        this.endPause = undefined;
        resolve();
      };
      const timer = setTimeout(end, this.deps.cancelPauseMs ?? DOUBLE_ESC_MS);
      this.endPause = end;
    });
  }

  private async ensureToken(): Promise<void> {
    const marginMs = (this.deps.remintMarginS ?? 30) * 1000;
    if (this.token.expiresAt * 1000 - this.deps.now() < marginMs) {
      this.token = await this.deps.cp.mintSessionToken(this.sessionId);
    }
  }

  private transcriptSafe(fn: () => void): void {
    try {
      fn();
    } catch {
      // Ignore errors from transcript store; it's a display cache only
    }
  }

  /** Feeds one stream's frames on, recording the turn and the last frame id. */
  private async consume(frames: AsyncGenerator<TurnFrame>, ids: Cursor): Promise<StreamEnd> {
    for await (const frame of frames) {
      ids.frames++;
      if (frame.type !== 'turn') ids.progress = (ids.progress ?? 0) + 1;
      this.pending = false;
      const deferred = this.takeDeferred();
      if (deferred && frame.type !== 'turn') {
        // Esc came before the first frame of a turn that is not detachable: abort it, as ever.
        this.controller?.abort();
        deferred.resolve(true);
        throw new TurnCancelledError();
      }
      if (frame.type === 'turn') {
        this.live = { turnId: frame.turnId, lastEventId: ids.last };
        this.lastTurnId = frame.turnId;
      } else if (this.live && ids.last) this.live.lastEventId = ids.last;
      this.transcriptSafe(() =>
        this.deps.transcripts?.appendFrame(this.sessionId, frame, ids.last),
      );
      this.emit({ kind: 'frame', frame });
      // Esc came before this turn frame: now it names the turn, cancel it on the server.
      if (deferred) void this.cancelRemote().then(deferred.resolve);
      if (frame.type === 'turn' && frame.ended) {
        // Nothing more is coming: the turn finished, and this client already holds its terminal.
        this.live = undefined;
        return 'caught-up';
      }
      if (isTerminal(frame)) {
        this.live = undefined;
        const cancelled = frame.type === 'error' && frame.abortReason === 'cancelled';
        this.emit(
          frame.type === 'done'
            ? { kind: 'turn-end', outcome: 'done' }
            : cancelled
              ? { kind: 'turn-end', outcome: 'cancelled' }
              : {
                  kind: 'turn-end',
                  outcome: 'error',
                  error: new Error(frame.errorMessage ?? frame.stopReason),
                },
        );
        return cancelled ? 'cancelled' : 'terminal';
      }
    }
    return 'ended';
  }

  private attachStream(
    controller: AbortController,
    ids: Cursor,
    lastEventId?: string,
  ): AsyncGenerator<TurnFrame> {
    return this.deps.harness.attach({
      sessionId: this.sessionId,
      token: this.token.token,
      lastEventId,
      signal: controller.signal,
      onEventId: (id) => (ids.last = id),
    });
  }

  /**
   * One attach call, read to its end. A rejected token is reminted once and the call retried, as
   * streamTurn does (clock skew passes ensureToken yet fails at the harness).
   */
  private async attachOnce(
    controller: AbortController,
    ids: Cursor,
    lastEventId?: string,
  ): Promise<StreamEnd> {
    await this.ensureToken();
    let reminted = false;
    for (;;) {
      const before = ids.frames;
      try {
        return await this.consume(this.attachStream(controller, ids, lastEventId), ids);
      } catch (err) {
        if (!isTokenRejection(err) || ids.frames !== before || controller.signal.aborted) throw err;
        if (reminted) throw err.code === 'session_mismatch' ? err : new HarnessUntrustedError();
        reminted = true;
        this.token = await this.deps.cp.mintSessionToken(this.sessionId);
      }
    }
  }

  /**
   * A detachable turn's stream dropped: re-attach with the last id (spec §6.5). Resolves true
   * when the turn ended cancelled. The budget is per drop: a try that delivered new frames
   * restarts the count and the backoff, so a long turn behind a proxy that cuts streams survives.
   * A harness that is briefly unavailable (5xx) is retried like a dropped stream.
   */
  private async reattach(controller: AbortController, ids: Cursor): Promise<boolean> {
    for (let attempt = 0; attempt < REATTACH_TRIES;) {
      await this.deps.sleep(REATTACH_BASE_MS * 2 ** attempt, controller.signal);
      if (controller.signal.aborted) throw new TurnCancelledError();
      const before = ids.progress ?? 0;
      try {
        const end = await this.attachOnce(controller, ids, this.live?.lastEventId);
        if (end === 'caught-up') {
          // The cursor already sat at the terminal, so its frame was read and rendered: a stream
          // that delivered it ends 'terminal', so this is only a defensive close of the turn.
          this.emit({ kind: 'turn-end', outcome: 'done' });
          return false;
        }
        if (end !== 'ended') return end === 'cancelled';
      } catch (err) {
        if (controller.signal.aborted || err instanceof TurnCancelledError)
          throw new TurnCancelledError();
        if (!isDropped(err) && !isUnavailable(err)) throw err;
      }
      attempt = (ids.progress ?? 0) > before ? 0 : attempt + 1;
    }
    this.live = undefined;
    throw new ApiError('harness', 0, 'stream_truncated', LOST_TURN_MESSAGE);
  }

  /** Resolves true when the turn ended cancelled. */
  private async runTurn(job: Extract<Job, { kind: 'prompt' }>): Promise<boolean> {
    const { prompt, resend } = job;
    const controller = new AbortController();
    this.controller = controller;
    // The prompt is recorded once its own turn is accepted (its first frame), or once the turn
    // ends without one. Not before a 409's attach: that records another device's turn, which must
    // not read as this prompt's answer; the prompt is recorded when its resend runs.
    let recorded = resend;
    let conflicted = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      this.transcriptSafe(() => this.deps.transcripts?.appendPrompt(this.sessionId, prompt));
    };
    this.emit({ kind: 'turn-start', prompt });
    let reminted = false;
    let streamed = false;
    const ids: Cursor = { frames: 0 };
    try {
      for (;;) {
        await this.ensureToken();
        try {
          // Until its first frame, a detachable turn may already run on the server (see `pending`).
          this.pending = this.deps.detachable === true;
          const raw = this.deps.harness.streamTurn({
            sessionId: this.sessionId,
            prompt,
            token: this.token.token,
            signal: controller.signal,
            detachable: this.deps.detachable === true,
            onEventId: (id) => (ids.last = id),
          });
          const frames = (async function* () {
            for await (const f of raw) {
              streamed = true;
              record();
              yield f;
            }
          })();
          const end = await this.consume(frames, ids);
          if (end !== 'ended') return end === 'cancelled';
          if (this.live) return await this.reattach(controller, ids);
          // Stream ended without a terminal frame; emit error
          this.emit({
            kind: 'turn-end',
            outcome: 'error',
            error: new Error('the harness ended the turn without a result'),
          });
          return false;
        } catch (err) {
          if (controller.signal.aborted || err instanceof TurnCancelledError)
            throw new TurnCancelledError();
          if (this.live && isDropped(err)) return await this.reattach(controller, ids);
          // Once frames have flowed the status code is spent; never re-send a half-run turn.
          if (!(err instanceof ApiError) || err.source !== 'harness' || streamed) throw err;
          this.pending = false;
          const deferred = this.takeDeferred();
          if (deferred) {
            // Esc while the request was out, and the harness refused it: no turn runs, so there is
            // nothing to cancel. The refusal ends the turn as ever; nothing sends it again (a retry,
            // a remint, a 409's attach), since the user withdrew it.
            deferred.resolve(true);
            const again =
              err.code === 'turn_in_progress' ||
              TOKEN_CODES.has(err.code) ||
              err.code === 'session_mismatch' ||
              (err.status === 503 && err.retryAfterS !== undefined);
            throw again ? new TurnCancelledError() : err;
          }
          if (
            this.deps.detachable === true &&
            err.code === 'turn_in_progress' &&
            job.conflicts < MAX_CONFLICTS
          ) {
            // Another device's turn holds the session: show it, then send this prompt (spec §6.5).
            // Only a detachable session attaches: headless fails the turn, as it always has. The
            // resend keeps `resend` as it was: this prompt is not recorded yet, so the resend does.
            const resend: PromptJob = { ...job, conflicts: job.conflicts + 1 };
            this.queue.unshift({ kind: 'attach', expectOpen: false, conflict: { resend } }, resend);
            conflicted = true;
            return false;
          }
          if (TOKEN_CODES.has(err.code) || err.code === 'session_mismatch') {
            // One remint covers an expired token and client/server clock skew. A token rejected
            // seconds after minting means the harness does not trust this control plane (§8.2).
            if (!reminted) {
              reminted = true;
              this.token = await this.deps.cp.mintSessionToken(this.sessionId);
              continue;
            }
            throw err.code === 'session_mismatch' ? err : new HarnessUntrustedError();
          }
          if (err.status === 503 && err.retryAfterS !== undefined) {
            this.emit({ kind: 'retrying', seconds: err.retryAfterS });
            await this.deps.sleep(err.retryAfterS * 1000, controller.signal);
            if (controller.signal.aborted) throw new TurnCancelledError();
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      this.live = undefined;
      this.transcriptSafe(() => this.deps.transcripts?.flush(this.sessionId));
      if (controller.signal.aborted || err instanceof TurnCancelledError) {
        this.emit({ kind: 'turn-end', outcome: 'cancelled' });
        return true;
      }
      this.emit({ kind: 'turn-end', outcome: 'error', error: err as Error });
      return false;
    } finally {
      // Ended with no frame (refused, cancelled before it, a stream with none): still the user's.
      if (!conflicted) record();
      this.live = undefined;
      this.pending = false;
      this.takeDeferred()?.resolve(true); // the turn is over: nothing is left to cancel
      if (this.controller === controller) this.controller = undefined;
    }
  }

  /** Catches up on the session's last turn: replays it, and follows it if it still runs. */
  private async runAttach(job: Extract<Job, { kind: 'attach' }>): Promise<boolean> {
    const controller = new AbortController();
    this.controller = controller;
    const ids: Cursor = { frames: 0 };
    this.conflict = job.conflict;
    this.emit({ kind: 'attach-start' });
    try {
      const end = await this.attachOnce(controller, ids, job.lastEventId);
      if (end === 'caught-up') {
        this.emit({ kind: 'attach-none', missed: false });
        return false;
      }
      if (end !== 'ended') return end === 'cancelled';
      if (this.live) return await this.reattach(controller, ids);
      // An attach stream always ends on a terminal; one that does not has lost the turn.
      throw new ApiError('harness', 0, 'stream_truncated', LOST_TURN_MESSAGE);
    } catch (err) {
      // Nothing to attach is only "none" before any frame showed: a re-attach that finds the turn
      // gone after its frames rendered has lost it, and ends as an error like any other.
      if (err instanceof ApiError && err.code === 'turn_not_found' && ids.frames === 0) {
        this.emit({ kind: 'attach-none', missed: job.expectOpen });
        return false;
      }
      if (controller.signal.aborted || err instanceof TurnCancelledError) {
        this.emit({ kind: 'turn-end', outcome: 'cancelled' });
        return true;
      }
      // Nothing was expected to run, and the harness could not be asked: there is nothing to show.
      if (
        !job.expectOpen &&
        ids.frames === 0 &&
        err instanceof ApiError &&
        err.source === 'harness' &&
        (err.code === 'network_error' || err.status === 503)
      ) {
        this.emit({ kind: 'attach-none', missed: false });
        return false;
      }
      if (this.live && isDropped(err)) {
        try {
          return await this.reattach(controller, ids);
        } catch (e) {
          if (controller.signal.aborted || e instanceof TurnCancelledError) {
            this.emit({ kind: 'turn-end', outcome: 'cancelled' });
            return true;
          }
          err = e;
        }
      }
      // The turn went away after its frames showed (turn_not_found from here on): that is a lost
      // turn, said in words rather than as the bare code.
      if (err instanceof ApiError && err.code === 'turn_not_found')
        err = new ApiError('harness', err.status, err.code, LOST_TURN_MESSAGE);
      this.emit({ kind: 'turn-end', outcome: 'error', error: err as Error });
      return false;
    } finally {
      this.live = undefined;
      this.conflict = undefined;
      this.transcriptSafe(() => this.deps.transcripts?.flush(this.sessionId));
      if (this.controller === controller) this.controller = undefined;
    }
  }
}

export class SessionManager {
  constructor(private readonly deps: SessionDeps) {}

  async create(req: CreateSessionRequest): Promise<ActiveSession> {
    const created = await this.deps.cp.createSession(req);
    this.deps.transcripts?.ensure(created.sessionId);
    return new ActiveSession(this.deps, created.sessionId, {
      token: created.token,
      expiresAt: created.expiresAt,
    });
  }

  async resume(sessionId: string): Promise<ActiveSession> {
    return new ActiveSession(this.deps, sessionId, await this.deps.cp.mintSessionToken(sessionId));
  }

  async remove(sessionId: string): Promise<'deleted' | 'accepted'> {
    let result: 'deleted' | 'accepted';
    try {
      result = await this.deps.cp.deleteSession(sessionId);
    } catch (err) {
      // Already gone (deleted from another machine, say): its history here has no session left.
      if (err instanceof ApiError && err.code === 'session_not_found') {
        this.deps.transcripts?.delete(sessionId);
      }
      throw err;
    }
    this.deps.transcripts?.delete(sessionId);
    return result;
  }
}
