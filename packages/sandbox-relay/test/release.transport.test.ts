import { Metadata, credentials, status } from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import { ReleaseOutcome, SandboxExecClient, type ReleaseResponse } from '@moca/k8s-sandbox';
import { RELEASE_CAPABILITY, WORKER_WITHOUT_RELEASE } from '../src/relay.js';
import { RELEASE_MAX_INFLIGHT, releaseErrorStatus } from '../src/sandbox-caller.js';
import {
  HARNESS,
  closeAll,
  reasons,
  relay,
  sleep,
  token,
  tokenB,
  worker,
  type ReleaseReply,
} from './helpers/sandbox-relay.js';

// #338: a sandbox-token caller releases its own workspace at its end. The relay checks it as it
// checks an Exec (the token's worker; the token's workspace key, never one the caller names), sends
// a ReleaseFrame only to a worker that advertises RELEASE_CAPABILITY, and ends every call: on the
// worker's answer, at the relay's timeout, or when the worker goes away. One audit line per call.

afterEach(closeAll);

/** A short release timeout, so a silent worker ends a call in the test's time. */
const SHORT = { releaseTimeoutMs: 300 };
const CAPS = [RELEASE_CAPABILITY];

interface CallResult {
  code: number;
  details: string;
  res?: ReleaseResponse;
}

function release(
  addr: string,
  t: string | undefined,
  sandboxId = 'sbx_default',
): Promise<CallResult> {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  if (t !== undefined) md.set('authorization', `Bearer ${t}`);
  return new Promise<CallResult>((resolve) =>
    client.release({ sandboxId }, md, (err, res) =>
      resolve(
        err ? { code: err.code, details: err.details } : { code: status.OK, details: '', res },
      ),
    ),
  ).finally(() => client.close());
}

const releaseLines = (lines: string[]) =>
  reasons(lines).filter((l) => l.audit === 'sandbox_workspace_release') as unknown as Array<
    Record<string, unknown>
  >;

const answers =
  (outcome: ReleaseOutcome): ReleaseReply =>
  () => ({ outcome });

/** A worker with the capability, answering every release with `reply`. */
const releaseWorker = (attach: string, reply?: ReleaseReply, caps = CAPS) =>
  worker(attach, 'sbx_default', 'auto', 0, undefined, undefined, undefined, caps, reply);

describe('Release (#338)', () => {
  it("sends the token's own workspace key and returns the worker's outcome", async () => {
    const r = await relay();
    const w = await releaseWorker(r.attach, answers(ReleaseOutcome.RELEASE_OUTCOME_RELEASED));
    const got = await release(r.exec, token());
    expect(got.code).toBe(status.OK);
    expect(got.res?.outcome).toBe(ReleaseOutcome.RELEASE_OUTCOME_RELEASED);
    expect(w.releases).toHaveLength(1);
    expect(w.releases[0]).toMatchObject({ workspaceKey: 'sbx-aaaa' });
    expect(w.releases[0]!.ctlId).toBeGreaterThan(0);
    expect(releaseLines(r.lines)).toEqual([
      expect.objectContaining({
        audit: 'sandbox_workspace_release',
        sub: 'github:1',
        sbx: 'sbx-aaaa',
        wrk: 'sbx_default',
        outcome: 'released',
      }),
    ]);
  });

  it('maps each outcome to its own audit outcome', async () => {
    for (const [outcome, name] of [
      [ReleaseOutcome.RELEASE_OUTCOME_KEPT_BUSY, 'kept_busy'],
      [ReleaseOutcome.RELEASE_OUTCOME_UNKNOWN_KEY, 'unknown_key'],
    ] as const) {
      const r = await relay();
      await releaseWorker(r.attach, answers(outcome));
      const got = await release(r.exec, token());
      expect(got.code).toBe(status.OK);
      expect(got.res?.outcome).toBe(outcome);
      expect(releaseLines(r.lines)[0]).toMatchObject({ outcome: name });
      await closeAll();
    }
  });

  it("refuses another worker's sandbox and sends the worker nothing", async () => {
    const r = await relay();
    const w = await releaseWorker(r.attach, answers(ReleaseOutcome.RELEASE_OUTCOME_RELEASED));
    const got = await release(r.exec, token(), 'sbx_other');
    expect(got.code).toBe(status.PERMISSION_DENIED);
    expect(w.releases).toEqual([]);
    expect(releaseLines(r.lines).map((l) => l.outcome)).toEqual(['refused']);
  });

  it("releases only the token's own workspace on a shared worker", async () => {
    const r = await relay();
    const w = await releaseWorker(r.attach, answers(ReleaseOutcome.RELEASE_OUTCOME_RELEASED));
    // Another sandbox on the same worker: its own key goes out, never sbx-aaaa's.
    expect((await release(r.exec, tokenB())).code).toBe(status.OK);
    expect(w.releases.map((f) => f.workspaceKey)).toEqual(['sbx-bbbb']);
  });

  it('refuses the harness exec token and an unauthenticated caller', async () => {
    const r = await relay({ MOCA_RELAY_EXEC_TOKEN: HARNESS });
    const w = await releaseWorker(r.attach, answers(ReleaseOutcome.RELEASE_OUTCOME_RELEASED));
    expect((await release(r.exec, HARNESS)).code).toBe(status.PERMISSION_DENIED);
    expect((await release(r.exec, undefined)).code).toBe(status.UNAUTHENTICATED);
    expect(w.releases).toEqual([]);
  });

  it('answers release_unsupported without a frame when the worker lacks the capability', async () => {
    const r = await relay();
    const w = await releaseWorker(r.attach, answers(ReleaseOutcome.RELEASE_OUTCOME_RELEASED), []);
    const got = await release(r.exec, token());
    expect(got.code).toBe(status.FAILED_PRECONDITION);
    expect(got.details).toBe(WORKER_WITHOUT_RELEASE);
    expect(w.releases).toEqual([]);
    expect(releaseLines(r.lines)[0]).toMatchObject({ outcome: 'unsupported' });
  });

  it('times out on a worker that never answers', async () => {
    const r = await relay({}, SHORT);
    const w = await releaseWorker(r.attach);
    const got = await release(r.exec, token());
    expect(got.code).toBe(status.DEADLINE_EXCEEDED);
    expect(w.releases).toHaveLength(1);
    expect(releaseLines(r.lines)[0]).toMatchObject({ outcome: 'timeout' });
  });

  it("maps the worker's error strings to statuses a client can act on", async () => {
    for (const [error, code] of [
      ['release_unsupported: no Release', status.FAILED_PRECONDITION],
      ['busy: 32 releases in flight', status.RESOURCE_EXHAUSTED],
      ['invalid-workspace-key: bad', status.INVALID_ARGUMENT],
      ['empty-workspace-key: empty', status.INVALID_ARGUMENT],
      ['pool closed', status.UNAVAILABLE],
    ] as const) {
      expect(releaseErrorStatus(error)).toBe(code);
      const r = await relay();
      await releaseWorker(r.attach, () => ({ error }));
      const got = await release(r.exec, token());
      expect(got.code).toBe(code);
      expect(got.details).toBe(error);
      await closeAll();
    }
  });

  it('is unavailable with no live worker, and fails a waiting call when the worker goes away', async () => {
    const r = await relay({}, { releaseTimeoutMs: 5_000 });
    expect((await release(r.exec, token())).code).toBe(status.UNAVAILABLE);
    const w = await releaseWorker(r.attach);
    const pending = release(r.exec, token());
    await sleep(150);
    expect(w.releases).toHaveLength(1);
    w.close();
    expect((await pending).code).toBe(status.UNAVAILABLE);
  });

  it(`answers busy past ${RELEASE_MAX_INFLIGHT} releases in flight for one sandbox`, async () => {
    const r = await relay({}, { releaseTimeoutMs: 5_000 });
    const w = await releaseWorker(r.attach);
    const held = Array.from({ length: RELEASE_MAX_INFLIGHT }, () => release(r.exec, token()));
    await sleep(150);
    expect(w.releases).toHaveLength(RELEASE_MAX_INFLIGHT);
    const over = await release(r.exec, token());
    expect(over.code).toBe(status.RESOURCE_EXHAUSTED);
    for (const f of w.releases) {
      w.answerRelease(f.ctlId, { outcome: ReleaseOutcome.RELEASE_OUTCOME_RELEASED });
    }
    expect((await Promise.all(held)).map((h) => h.code)).toEqual(
      Array(RELEASE_MAX_INFLIGHT).fill(status.OK),
    );
  });
});
