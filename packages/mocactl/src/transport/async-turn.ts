/**
 * The async-turn backend for leaf dispatch (ADR-0047): `POST /v1/sessions/{id}/turns` with
 * `async: true`, then `GET …/turns/{turnId}` to follow it. The replacement `leaf-turn.ts` was
 * written for — same two operations, same `LeafResultBody` out, so `spawn`/`subagents`/`get` do not
 * care which one they hold.
 *
 * Two things it buys over the sync `/runs` path: a turn record, which is what makes a subagent
 * cancellable, and no local process — the control plane holds the dispatch, so nothing on this
 * machine has to survive the command.
 *
 * It needs `SH_ASYNC_DRAIN=1` on at least one worker of the deployment. That is off by default, so
 * `spawn --async` is opt-in rather than the default; without a drain the turn stays `queued` until
 * the reaper calls it `lost`.
 */
import type { ControlPlaneApi, SubmitTurnRequest, TurnStatus } from '../api/types.js';
import type { LeafEnvelope, LeafResultBody } from './leaf-turn.js';

/** The two methods of the control-plane API this transport uses, so a test can pass a stub. */
export type TurnApi = Pick<ControlPlaneApi, 'submitTurn' | 'getTurn' | 'getTurnArtifact'>;

export class AsyncTurnTransport {
  constructor(private readonly cp: TurnApi) {}

  /**
   * Queue the leaf as an async turn; the returned `turnId` is the handle for reading and cancelling
   * it. Throws ApiError `async_quota_exhausted` (429) when the caller already holds the
   * deployment's limit of non-terminal turns.
   *
   * `configRef` is deliberately not sent: the turn copies the session's own config at submission,
   * and `spawn` already created the session with it. `workloadId` is not sent either — the control
   * plane refuses a workload on the async path with 501, which `cmdSpawn` reports before we get here.
   */
  async submit(envelope: LeafEnvelope): Promise<string> {
    const req: SubmitTurnRequest = {
      async: true,
      kind: envelope.kind,
      ...(envelope.prompt !== undefined ? { prompt: envelope.prompt } : {}),
      ...(envelope.problemStatement !== undefined
        ? { problemStatement: envelope.problemStatement }
        : {}),
      ...(envelope.repoUrl !== undefined ? { repoUrl: envelope.repoUrl } : {}),
      ...(envelope.ref !== undefined ? { ref: envelope.ref } : {}),
    };
    return (await this.cp.submitTurn(envelope.sessionId, req)).turnId;
  }

  /**
   * One status read, WITHOUT the output's bytes: `subagents` reads every live row on every call, and
   * a 4 MiB patch per row per call is what the bounded status body exists to avoid. `cmdGet` calls
   * `collect` once it has a terminal body.
   *
   * `'queued'` covers both non-terminal states, matching what the sync transport returns while a
   * leaf is still running, so `mapHonestState` needs no new case. The caller treats an async row as
   * alive on `'queued'`: the turn record IS the liveness here, there being no child to probe.
   */
  async readTurnState(
    sessionId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<LeafResultBody | 'queued'> {
    return bodyFromTurn(await this.cp.getTurn(sessionId, turnId, { signal }));
  }

  /**
   * The same body with the output filled in from the turn's artifacts, which is what `get` writes to
   * files. Only the kinds the record said it has: asking for one it hasn't is a 404, and a turn with
   * no artifacts at all (a failure, a gate) costs no request.
   */
  async collect(
    sessionId: string,
    turnId: string,
    body: LeafResultBody,
    signal?: AbortSignal,
  ): Promise<LeafResultBody> {
    const kinds = body.artifacts ?? [];
    const out = { ...body };
    delete out.artifacts;
    for (const kind of ['text', 'patch'] as const) {
      if (!kinds.includes(kind)) continue;
      out[kind] = await this.cp.getTurnArtifact(sessionId, turnId, kind, { signal });
    }
    return out;
  }
}

/**
 * A turn record as the sync path's result body, so one set of status/terminal rules covers both.
 *
 * `lost` is the reaper's: the turn was claimed and never finalized, which is a failure with a name
 * worth carrying. `cancelled` maps to `aborted`, the status the sync path already has for a run that
 * was stopped — `terminalFromBody` reads both as `failed`, which a cancelled turn is not a success of.
 */
function bodyFromTurn(turn: TurnStatus): LeafResultBody | 'queued' {
  if (turn.state === 'queued' || turn.state === 'running') return 'queued';
  if (turn.state === 'lost') {
    return { status: 'failed', reason: 'lost', message: 'the turn was claimed but never finished' };
  }
  if (turn.state === 'cancelled') return { status: 'aborted', reason: 'cancelled' };
  const result = turn.result;
  // A terminal turn whose leaf stored no result: the turn's own state is all there is to report,
  // and it is the authority on status (async spec §4.4).
  if (!result) return { status: turn.state };
  return {
    // The record's status, which can be finer than the turn's (`responded` vs `done`). The turn
    // state is the fallback, never overridden: a result that disagrees is still this turn's result.
    status: (result.status as LeafResultBody['status']) || turn.state,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.gate ? { gate: result.gate as LeafResultBody['gate'] } : {}),
    // `summary` is deliberately dropped: it is a clipped line derived from fields already here (the
    // text, the gate's summary, the diffstat, the reason), and `get` writes files from the bytes.
    artifacts: (result.artifacts ?? []).map((a) => a.kind),
  };
}
